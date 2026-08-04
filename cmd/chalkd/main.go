// Command chalkd is the chalk server daemon.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"

	chalk "github.com/scuq/chalk"
	"github.com/scuq/chalk/internal/auth"
	"github.com/scuq/chalk/internal/config"
	"github.com/scuq/chalk/internal/friends"
	"github.com/scuq/chalk/internal/giphy"
	"github.com/scuq/chalk/internal/linkpreview"
	"github.com/scuq/chalk/internal/mail"
	"github.com/scuq/chalk/internal/migrate"
	"github.com/scuq/chalk/internal/presence"
	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/server"
	"github.com/scuq/chalk/internal/store"
	"github.com/scuq/chalk/internal/version"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "chalkd: "+err.Error())
		os.Exit(1)
	}
}

func run(args []string) error {
	cfg, err := config.Load(args)
	if err != nil {
		if errors.Is(err, config.ErrVersionRequested) {
			fmt.Println(version.String())
			return nil
		}
		return err
	}

	if cfg.InstanceID == "" {
		cfg.InstanceID = "instance-" + uuid.NewString()[:8]
	}

	log.SetFlags(log.LstdFlags | log.LUTC)
	log.Printf("starting %s (instance=%s listen=%s tls=%s log=%s)",
		version.String(), cfg.InstanceID, cfg.Listen, cfg.TLSMode, cfg.LogLevel)

	if cfg.DBURL == "" {
		return errors.New("missing database URL: set --db-url or CHALK_DB_URL")
	}

	connectCtx, cancelConnect := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancelConnect()

	st, err := store.Open(connectCtx, cfg.DBURL)
	if err != nil {
		return fmt.Errorf("connect db: %w", err)
	}
	defer st.Close()
	log.Printf("connected to database")

	// gov-1a: hand the server-wide governance defaults to the store so new
	// channels seed their per-channel governance columns from them. Log the
	// effective config like the rest of startup.
	st.GovDefaults = store.GovernanceConfig{
		Mode:                   cfg.Governance.DefaultMode,
		VoteWindowDays:         cfg.Governance.VoteWindowDays,
		VoteExpiryHours:        cfg.Governance.VoteExpiryHours,
		MinEligible:            cfg.Governance.MinEligible,
		QuorumPercent:          cfg.Governance.QuorumPercent,
		PassPercent:            cfg.Governance.PassPercent,
		SupermajorityPercent:   cfg.Governance.SupermajorityPercent,
		ReproposeCooldownHours: cfg.Governance.ReproposeCooldownHours,
	}
	log.Printf("governance: default_mode=%s window_days=%d expiry_hours=%d min_eligible=%d quorum=%d%% pass=%d%% supermajority=%d%% repropose_cooldown_hours=%d",
		cfg.Governance.DefaultMode, cfg.Governance.VoteWindowDays, cfg.Governance.VoteExpiryHours,
		cfg.Governance.MinEligible, cfg.Governance.QuorumPercent, cfg.Governance.PassPercent,
		cfg.Governance.SupermajorityPercent, cfg.Governance.ReproposeCooldownHours)

	migs, err := migrate.Load(chalk.Migrations, chalk.MigrationsDir)
	if err != nil {
		return fmt.Errorf("load migrations: %w", err)
	}
	log.Printf("loaded %d migration(s)", len(migs))

	results, err := migrate.Run(connectCtx, st.Pool, migs, log.Printf)
	if err != nil {
		return fmt.Errorf("apply migrations: %w", err)
	}
	applied := 0
	for _, r := range results {
		if !r.Skipped {
			applied++
		}
	}
	log.Printf("migrations: %d total, %d applied, %d already-applied",
		len(results), applied, len(results)-applied)

	// Pre-create monthly partitions for the messages table. Doing this here
	// (post-migrations, pre-Serve) means partition existence is part of
	// startup correctness rather than a side effect of the running loop.
	if err := st.EnsureMessagePartitions(connectCtx, time.Now().UTC()); err != nil {
		return fmt.Errorf("ensure partitions: %w", err)
	}
	if err := st.EnsureAttachmentPartitions(connectCtx, time.Now().UTC()); err != nil {
		return fmt.Errorf("ensure attachment partitions: %w", err)
	}
	log.Printf("partitions ensured for current and next month")

	// Phase 23f (fail-closed): the default channel is RETIRED. It had
	// created_by IS NULL and no members, so under mandatory encryption it could
	// never be bootstrapped with a key -- it cannot be used. All conversation
	// now happens in real, encrypted channels. We no longer create it.
	// (EnsureDefaultChannel remains in the store for now but is uncalled.)
	_ = store.DefaultChannelID // retained for the legacy fallback constants

	// Phase 09d-1: first-run admin bootstrap. If no admin row
	// exists yet AND the operator set CHALK_ADMIN_USERNAME and
	// CHALK_ADMIN_EMAIL, insert the admin row (no passkey) and
	// mint a one-time bootstrap token. The URL is printed to
	// stderr so the operator can complete enrollment in the
	// browser. Reuses an existing active token if one is still
	// in flight (e.g. chalkd restarted mid-bootstrap).
	if err := maybeBootstrapAdmin(connectCtx, st, cfg); err != nil {
		return fmt.Errorf("admin bootstrap: %w", err)
	}

	if cfg.MigrateOnly {
		log.Printf("--migrate-only set; exiting")
		return nil
	}

	// Phase 06: presence + friends. Both stores share the same pgxpool
	// as the message store; they're stateless wrappers. The loop config
	// reads env-var overrides (test-only knobs) on top of the production
	// defaults (5s heartbeat / 10s janitor / 15s staleness / 5s demotion).
	presenceStore := &presence.Store{Pool: st.Pool}
	friendsStore := &friends.Store{Pool: st.Pool}
	presenceLoopCfg := presence.LoopConfigFromEnv()

	// Phase 09b sub-step 3: auth service + ceremony cache.
	//
	// RPOrigins: if the operator set CHALK_RP_ORIGINS, use that;
	// otherwise derive a single origin from the listen address and
	// TLS mode. The derivation is a best-effort default for single-
	// host deployments; multi-host setups must set the env var.
	authCfg := auth.Config{
		RPID:          cfg.RPID,
		RPDisplayName: cfg.RPName,
		RPOrigins:     splitOrigins(cfg.RPOrigins),
	}
	if len(authCfg.RPOrigins) == 0 {
		authCfg.RPOrigins = []string{deriveOrigin(cfg.Listen, cfg.TLSMode)}
	}
	authSvc, err := auth.NewService(authCfg)
	if err != nil {
		return fmt.Errorf("auth: %w", err)
	}
	ceremonyCache := auth.NewCeremonyCache(0) // default TTL
	// Phase 09c: outbound mail. Uses CHALK_SMTP_HOST/_PORT/_FROM/...
	// If CHALK_SMTP_HOST is unset, falls back to writing every
	// message to stderr — handy for dev without a Mailhog container.
	mailCfg := mail.LoadConfigFromEnv(log.Default())
	mailer := mail.New(mailCfg)
	if mailCfg.Host == "" {
		log.Printf("mail: stderr fallback (set CHALK_SMTP_HOST to enable SMTP)")
	} else {
		log.Printf("mail: smtp host=%s port=%d from=%q",
			mailCfg.Host, mailCfg.Port, mailCfg.From)
	}
	publicURL := strings.TrimSpace(os.Getenv("CHALK_PUBLIC_URL"))
	// att-4: build the Giphy search-proxy client iff an API key is set.
	// When unset, giphyClient stays nil -> the search endpoint answers 503
	// and /api/auth/config reports giphy_enabled=false. The key never
	// leaves the server.
	var giphyClient *giphy.Client
	if cfg.Giphy.Enabled() {
		giphyClient = giphy.New(
			cfg.Giphy.APIKey,
			cfg.Giphy.SearchLimit,
			cfg.Giphy.Rating,
			cfg.Giphy.Timeout(),
		)
		log.Printf("giphy: search proxy enabled (limit=%d rating=%s)",
			cfg.Giphy.SearchLimit, cfg.Giphy.Rating)
	} else {
		log.Printf("giphy: disabled (CHALK_GIPHY_API_KEY unset)")
	}

	// 57-1: build the link-preview fetcher unless disabled. When disabled,
	// lpClient stays nil -> the endpoints answer 503 and /api/auth/config
	// reports linkpreview_enabled=false.
	var lpClient *linkpreview.Client
	if cfg.LinkPreview.Enabled {
		lpClient = linkpreview.New(cfg.LinkPreview.Timeout())
		log.Printf("linkpreview: enabled (domains=%v)", cfg.LinkPreview.Domains)
	} else {
		log.Printf("linkpreview: disabled (CHALK_LINKPREVIEW_ENABLED=false)")
	}

	authDeps := &auth.HTTPDeps{
		Service:       authSvc,
		Cache:         ceremonyCache,
		Store:         st,
		Logger:        log.Default(),
		AdminUsername: cfg.AdminUsername,
		Mailer:        mailer,
		PublicURL:     publicURL,

		// att-1: attachment limits.
		AttachMaxBytes:    cfg.Attachments.MaxBytes,
		AttachChunkBytes:  cfg.Attachments.ChunkBytes,
		AttachFetchWindow: cfg.Attachments.FetchWindow(),

		// att-4: Giphy search proxy (nil when no API key configured).
		GiphyClient: giphyClient,

		// 57-1: link previews (nil when disabled).
		LinkPreview:        lpClient,
		LinkPreviewDomains: cfg.LinkPreview.Domains,

		// 30-8: uplink probe endpoint policy.
		NetprobeEnabled:  cfg.Voice.Enabled && cfg.Voice.ProbeEnabled,
		NetprobeMaxBytes: cfg.Voice.ProbeBytes,

		// 80-8: guest magic-link redemption endpoints.
		EphemeralEnabled: cfg.Ephemeral.Enabled,

		// 85-1: security-event logging (lockouts, rate limits, login outcomes).
		SecurityLog: cfg.Oplog.SecurityEvents,
	}
	log.Printf("auth: rp_id=%q rp_name=%q rp_origins=%v open_registration=%v dev=%v",
		authCfg.RPID, authCfg.RPDisplayName, authCfg.RPOrigins,
		auth.IsOpenRegistration(), auth.IsDevMode())
	if publicURL != "" {
		log.Printf("auth: public_url=%q (used in outgoing mail)", publicURL)
	} else {
		log.Printf("auth: CHALK_PUBLIC_URL unset; mail URLs will be relative")
	}

	wsCfg := server.DefaultWSConfig()
	wsCfg.AttachMaxPerMessage = cfg.Attachments.MaxPerMessage
	// 42-5: thread inbox recency window.
	wsCfg.ThreadActiveWindow = cfg.Threads.ActiveWindow()
	// 80-6: ephemeral voice channels. The feature additionally needs the
	// chalk_guest pool (CHALK_DB_URL_GUEST) for the join path; creating
	// rooms and minting links only needs these knobs.
	wsCfg.Ephemeral = server.EphemeralWSConfig{
		Enabled:      cfg.Ephemeral.Enabled,
		MaxTTL:       cfg.Ephemeral.MaxTTL(),
		InviteMaxTTL: cfg.Ephemeral.InviteMaxTTL(),
		MaxGuests:    cfg.Ephemeral.MaxGuests,
	}
	if cfg.Ephemeral.Enabled {
		log.Printf("ephemeral: enabled max_ttl=%s invite_max_ttl=%s max_guests=%d guest_pool=%v",
			cfg.Ephemeral.MaxTTL(), cfg.Ephemeral.InviteMaxTTL(), cfg.Ephemeral.MaxGuests,
			cfg.DBURLGuest != "")
	} else {
		log.Printf("ephemeral: disabled (CHALK_EPHEMERAL_ENABLED=false)")
	}
	// 82-6: signed-wrap enforcement.
	wsCfg.WrapSigRequired = cfg.WrapSigRequired
	if cfg.WrapSigRequired {
		log.Printf("channel keys: signed wraps REQUIRED (CHALK_WRAP_SIG_REQUIRED=true); unsigned publishes refused")
	}
	// 85-1: say what the logging will do, so an operator reading a quiet log
	// can tell "nothing happened" from "nothing is being recorded".
	snapshot := "off"
	if cfg.Oplog.SnapshotInterval > 0 {
		snapshot = cfg.Oplog.SnapshotInterval.String()
	}
	slow := "off"
	if cfg.Oplog.SlowRequest > 0 {
		slow = cfg.Oplog.SlowRequest.String()
	}
	log.Printf("oplog: security_events=%v conn_snapshot=%s slow_request=%s",
		cfg.Oplog.SecurityEvents, snapshot, slow)

	// 30-2: voice signaling knobs.
	wsCfg.Voice = server.VoiceWSConfig{
		Enabled:         cfg.Voice.Enabled,
		MaxParticipants: cfg.Voice.MaxParticipants,
		ForceRelay:      cfg.Voice.ForceRelay,
		TurnURLs:        cfg.Voice.TurnURLList(),
		TurnSecret:      cfg.Voice.TurnSecret,
		TurnTTL:         cfg.Voice.TurnTTL(),
		StunURLs:        cfg.Voice.StunURLList(),
		// 30-8: adaptive-quality policy echoed on voice_join_ack.
		Adaptive: &proto.VoiceAdaptiveConfig{
			ProbeEnabled:   cfg.Voice.ProbeEnabled,
			ProbeBytes:     cfg.Voice.ProbeBytes,
			RecheckSecs:    cfg.Voice.RecheckSecList(),
			UplinkHeadroom: cfg.Voice.UplinkHeadroom,
			AudioKbps:      cfg.Voice.AudioKbps,
			MinVideoKbps:   cfg.Voice.MinVideoKbps,
		},
	}
	if cfg.Voice.Enabled {
		log.Printf("voice: enabled max_participants=%d force_relay=%v turn_urls=%d stun_urls=%d ttl=%s",
			cfg.Voice.MaxParticipants, cfg.Voice.ForceRelay,
			len(cfg.Voice.TurnURLList()), len(cfg.Voice.StunURLList()), cfg.Voice.TurnTTL())
	}
	// 80-9: the chalk_guest pool. Optional: without it the ephemeral join
	// endpoints still answer, but guest WS connections are refused -- a
	// pre-phase-80 env simply lacks the feature.
	var guestStore *store.Guest
	if cfg.Ephemeral.Enabled && cfg.DBURLGuest != "" {
		guestStore, err = store.OpenGuest(connectCtx, cfg.DBURLGuest)
		if err != nil {
			return fmt.Errorf("connect guest db: %w", err)
		}
		defer guestStore.Close()
		log.Printf("connected guest pool (chalk_guest)")
	}

	srv, err := server.NewServer(server.Options{
		Listen:             cfg.Listen,
		Store:              st,
		GuestStore:         guestStore,
		Hub:                server.NewHub(),
		WSConfig:           wsCfg,
		InstanceID:         cfg.InstanceID,
		Logger:             log.Default(),
		Presence:           presenceStore,
		Friends:            friendsStore,
		PresenceLoopConfig: &presenceLoopCfg,
		// Phase 07: serve the embedded SPA at "/". The chalk root
		// package's embed.FS is rooted at the module root; the SPA
		// handler navigates into web/dist itself.
		WebFS:  chalk.Web,
		WebDir: chalk.WebDir,
		// Phase 09b sub-step 3: registration endpoints.
		Auth: authDeps,
		// att-1: orphan-upload janitor TTL.
		AttachOrphanTTL: cfg.Attachments.OrphanTTL(),
		// 85-2/85-3: operational logging.
		SnapshotInterval: cfg.Oplog.SnapshotInterval,
		SlowRequest:      cfg.Oplog.SlowRequest,
	})
	if err != nil {
		return fmt.Errorf("server: %w", err)
	}
	// Phase 09d-1: wire the hub into authDeps so admin block /
	// soft-delete / purge can close active WS conns for the
	// moderated user. authDeps is a pointer; the auth handlers
	// read d.Kicker at request time so this late assignment is
	// safe (no requests are served yet).
	authDeps.Kicker = srv.Hub()
	// 80-14: first guest redemption pushes member_added to the room, so
	// members see the guest's name immediately. Same late-assignment
	// pattern as Kicker (no requests served yet).
	authDeps.OnGuestJoined = srv.NotifyGuestJoined

	if cfg.PrintListen {
		fmt.Printf("listening on %s\n", srv.Addr())
	}
	if cfg.ListenInfoFile != "" {
		if err := writeListenInfo(cfg.ListenInfoFile, srv.Addr().String()); err != nil {
			return fmt.Errorf("write listen-info-file: %w", err)
		}
		defer os.Remove(cfg.ListenInfoFile)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Phase 09b sub-step 3: keep the ceremony cache tidy. Janitor
	// exits when ctx is canceled (i.e. server shutdown).
	go ceremonyCache.RunJanitor(ctx, 0)

	// Phase 09b sub-step 5: session janitor. Sweeps expired session
	// rows from the sessions table hourly. Exits when ctx is canceled.
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				n, err := st.DeleteExpiredSessions(ctx)
				if err != nil {
					log.Printf("session janitor: %v", err)
					continue
				}
				if n > 0 {
					log.Printf("session janitor: deleted %d expired session(s)", n)
				}
				// 80-9: guest sessions that expired while their room lives on.
				gn, gerr := st.DeleteExpiredEphemeralSessions(ctx)
				if gerr != nil {
					log.Printf("session janitor: %v", gerr)
					continue
				}
				if gn > 0 {
					log.Printf("session janitor: deleted %d expired guest session(s)", gn)
				}
			}
		}
	}()

	// Phase 09c: invite janitor. Sweeps silently-expired invites
	// (used and revoked rows are kept for audit). Same hourly
	// cadence as the session janitor.
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				n, err := st.DeleteExpiredInvites(ctx)
				if err != nil {
					log.Printf("invite janitor: %v", err)
					continue
				}
				if n > 0 {
					log.Printf("invite janitor: deleted %d expired invite(s)", n)
				}
			}
		}
	}()

	errCh := make(chan error, 1)
	go func() {
		err := srv.Serve(ctx)
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
		close(errCh)
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-sigCh:
		log.Printf("received %s, shutting down (grace=%s)", sig, cfg.ShutdownGrace)
	case err, ok := <-errCh:
		if ok && err != nil {
			return fmt.Errorf("serve: %w", err)
		}
		return nil
	}

	cancel()
	select {
	case <-errCh:
	case <-time.After(cfg.ShutdownGrace + 5*time.Second):
		return errors.New("server shutdown timed out")
	}
	log.Printf("clean shutdown")
	return nil
}

func writeListenInfo(path, addr string) error {
	dir := "."
	if d := dirOf(path); d != "" {
		dir = d
	}
	tmp, err := os.CreateTemp(dir, ".listen-info-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if _, err := tmp.WriteString(addr + "\n"); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, path)
}

func dirOf(path string) string {
	for i := len(path) - 1; i >= 0; i-- {
		if path[i] == '/' || path[i] == '\\' {
			return path[:i]
		}
	}
	return ""
}

// splitOrigins parses a comma-separated CHALK_RP_ORIGINS value into a
// slice of trimmed entries, dropping empties. Empty input returns nil
// so the caller can detect "not set" and fall back to derivation.
func splitOrigins(s string) []string {
	if s == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

// deriveOrigin builds a default RP origin from the listen address and
// TLS mode. Best-effort for single-host deployments; multi-host setups
// must set CHALK_RP_ORIGINS explicitly.
//
// "localhost" host + non-TLS gives http://localhost:8443; same with
// TLS gives https://localhost:8443. A bare ":8443" listen is
// rewritten to "localhost:8443". A "0.0.0.0:8443" or "[::]:8443"
// listen also assumes localhost from the client's perspective; if
// chalkd is bound on a wildcard, the actual hostname clients use is
// unknowable here. The operator should set CHALK_RP_ORIGINS in that
// case.
func deriveOrigin(listen, tlsMode string) string {
	scheme := "http"
	if tlsMode != "off" {
		scheme = "https"
	}
	host, port, ok := strings.Cut(listen, ":")
	if !ok {
		host = "localhost"
		port = listen
	}
	switch host {
	// sub-step 4 fix2: rewrite loopback IPs to localhost
	// WebAuthn doesn't allow IP-literal RP IDs, and chalk's
	// auth.Config defaults RPID to "localhost". Keeping the
	// origin host in sync (127.0.0.1 → localhost, ::1 → localhost)
	// avoids the inconsistency that produced SecurityError in the
	// browser when chalkd bound to 127.0.0.1.
	case "", "0.0.0.0", "[::]", "::", "127.0.0.1", "::1", "[::1]":
		host = "localhost"
	}
	return fmt.Sprintf("%s://%s:%s", scheme, host, port)
}

// maybeBootstrapAdmin seeds the admin IDENTITY on first run if no admin
// row exists yet AND the operator has set both CHALK_ADMIN_USERNAME and
// CHALK_ADMIN_EMAIL. Idempotent: skipped if an admin already exists.
//
// It seeds a row with no credentials on it. Taking possession of that
// row — password + TOTP — is the operator's job, via the enrollment URL
// chalkctl prints (/?admin_token=<CHALK_ADMIN_BOOTSTRAP_TOKEN>). The
// absence of credentials is exactly what makes the row claimable, so
// this must not attach any.
func maybeBootstrapAdmin(ctx context.Context, st *store.Store, cfg config.Config) error {
	// Probe: is an admin already bootstrapped? Use GetAdminUser
	// which returns ErrNotFound when absent. Any other error is
	// fatal (we can't reason about admin state).
	if _, err := st.GetAdminUser(ctx); err == nil {
		// Admin exists. Bootstrap already done. Nothing more here.
		return nil
	} else if !errors.Is(err, store.ErrNotFound) {
		return fmt.Errorf("probe admin: %w", err)
	}

	username := strings.ToLower(strings.TrimSpace(cfg.AdminUsername))
	email := strings.ToLower(strings.TrimSpace(cfg.AdminEmail))
	displayName := strings.TrimSpace(cfg.AdminDisplayName)
	if username == "" || email == "" {
		log.Printf("admin bootstrap: no admin yet; set CHALK_ADMIN_USERNAME and CHALK_ADMIN_EMAIL to bootstrap")
		return nil
	}

	// Insert the admin row.
	admin, err := st.BootstrapAdminUser(ctx, store.BootstrapAdminUserParams{
		Username:    username,
		Email:       email,
		DisplayName: displayName,
	})
	if err != nil {
		if errors.Is(err, store.ErrAdminExists) {
			// Race with a parallel chalkd: another instance won.
			log.Printf("admin bootstrap: another instance already bootstrapped; skipping")
			return nil
		}
		return fmt.Errorf("BootstrapAdminUser: %w", err)
	}
	log.Printf("admin bootstrap: seeded admin user %q (id=%s); claim it at "+
		"/?admin_token=<CHALK_ADMIN_BOOTSTRAP_TOKEN>", admin.Username, admin.ID)
	return nil
}

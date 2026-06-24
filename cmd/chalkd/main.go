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
	"github.com/scuq/chalk/internal/mail"
	"github.com/scuq/chalk/internal/migrate"
	"github.com/scuq/chalk/internal/presence"
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
	srv, err := server.NewServer(server.Options{
		Listen:             cfg.Listen,
		Store:              st,
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

// maybeBootstrapAdmin runs the first-run admin bootstrap if no admin
// row exists yet AND the operator has set both CHALK_ADMIN_USERNAME
// and CHALK_ADMIN_EMAIL. Idempotent: skipped if an admin already
// exists. Phase 09d-1.
//
// Output: on a fresh bootstrap, prints the admin enrollment URL to
// stderr. If an active token already exists (e.g. the previous run
// minted one but the operator never visited the URL), reuses it
// rather than minting a new one — this lets a restart not invalidate
// a still-valid URL.
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
	log.Printf("admin bootstrap: created admin user %q (id=%s)", admin.Username, admin.ID)

	// Mint a bootstrap token (or reuse an existing active one).
	tok, err := st.GetActiveAdminBootstrapToken(ctx)
	if errors.Is(err, store.ErrNotFound) {
		tok, err = st.CreateAdminBootstrapToken(ctx)
		if errors.Is(err, store.ErrAdminBootstrapActive) {
			// Raced with a concurrent instance that won. Re-fetch.
			tok, err = st.GetActiveAdminBootstrapToken(ctx)
		}
		if err != nil {
			return fmt.Errorf("CreateAdminBootstrapToken: %w", err)
		}
	} else if err != nil {
		return fmt.Errorf("GetActiveAdminBootstrapToken: %w", err)
	}

	publicURL := strings.TrimSpace(os.Getenv("CHALK_PUBLIC_URL"))
	if _, err := auth.PrintBootstrapURL(os.Stderr, publicURL, tok.Token, tok.ExpiresAt); err != nil {
		// Logging failure is non-fatal; the token is still in
		// the DB.
		log.Printf("admin bootstrap: PrintBootstrapURL: %v", err)
	}
	return nil
}

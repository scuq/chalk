package chalkctl

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// InitOptions carries everything `chalkctl init` needs beyond Config: the
// paths (overridable for tests), the resolved verifier, and behavior flags.
type InitOptions struct {
	Cfg         Config
	Version     string    // release tag to deploy, e.g. "v0.1.0" or "stable"
	Verifier    Verifier  // CosignVerifier or NoopVerifier
	Podman      *Podman   // nil -> NewPodman()
	ConfigPath  string    // DefaultConfigPath
	StatePath   string    // DefaultStatePath
	EnvPath     string    // DefaultEnvPath
	QuadletDir  string    // DefaultQuadletDir
	CaddyfileAt string    // DefaultCaddyfile
	NoStart     bool      // write everything but don't systemctl start
	Out         io.Writer // progress log; nil -> os.Stdout

	// Force re-runs init over an existing deployment (re-render config + env,
	// restart). WITHOUT DropDB it PRESERVES the existing DB and secrets (so a
	// config-only change doesn't break the database). With DropDB it wipes the
	// postgres volume and generates fresh secrets.
	Force  bool
	DropDB bool
	// Confirm is called for destructive actions (DropDB). It must return true
	// to proceed. nil -> a default interactive prompt (stdin). Set to a
	// func returning true for --yes / non-interactive.
	Confirm func(prompt string) bool
}

func (o *InitOptions) defaults() {
	if o.Podman == nil {
		o.Podman = NewPodman()
	}
	if o.ConfigPath == "" {
		o.ConfigPath = DefaultConfigPath
	}
	if o.StatePath == "" {
		o.StatePath = DefaultStatePath
	}
	if o.EnvPath == "" {
		o.EnvPath = DefaultEnvPath
	}
	if o.QuadletDir == "" {
		o.QuadletDir = DefaultQuadletDir
	}
	if o.CaddyfileAt == "" {
		o.CaddyfileAt = DefaultCaddyfile
	}
	if o.Out == nil {
		o.Out = os.Stdout
	}
	if o.Version == "" {
		o.Version = o.Cfg.Channel // "stable" by default
	}
}

func (o *InitOptions) logf(format string, a ...any) {
	fmt.Fprintf(o.Out, "  "+format+"\n", a...)
}

// Init runs the full bootstrap. Order matters:
//  1. preflight (root, config valid, not already initialized, cosign present)
//  2. verify the image signature (unless --skip-verify)
//  3. pull + resolve the immutable digest (the pin the units carry)
//  4. generate secrets, render env + units + Caddyfile, write to disk
//  5. daemon-reload + start the stack (unless --no-start)
//  6. write config + state, install the weekly update timer
//
// Idempotency: refuses to run if state already exists (points at `update`).
func Init(o InitOptions) error {
	o.defaults()
	cfg := o.Cfg

	// -- 1. preflight --------------------------------------------------------
	if cfg.Rootful {
		if err := RequireRoot(); err != nil {
			return err
		}
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	_, initialized, err := LoadState(o.StatePath)
	if err != nil {
		return err
	}
	if initialized && !o.Force {
		return fmt.Errorf("already initialized (%s exists) -- pass --force to re-apply config, add --drop-db to also wipe the database", o.StatePath)
	}

	// Destructive-action confirmation (DropDB). Preserve-secrets path needs
	// no confirmation; wiping the DB does.
	confirm := o.Confirm
	if confirm == nil {
		confirm = promptConfirm
	}
	if o.DropDB {
		if !confirm(fmt.Sprintf(
			"This will PERMANENTLY DELETE the chalk database for %s.\nType the domain (%s) to confirm: ",
			cfg.Domain, cfg.Domain)) {
			return fmt.Errorf("aborted: database wipe not confirmed")
		}
	} else if o.Force && initialized {
		o.logf("--force: re-applying config, PRESERVING the existing database")
	}

	imageTag := cfg.Image + ":" + o.Version
	fmt.Fprintf(o.Out, "chalkctl init: deploying %s to %s\n", imageTag, cfg.Domain)
	o.logf("verifier: %s", o.Verifier.Describe())

	// -- 2. verify -----------------------------------------------------------
	o.logf("verifying image signature...")
	if err := o.Verifier.Verify(imageTag); err != nil {
		return fmt.Errorf("signature verification failed (pass --skip-verify to override): %w", err)
	}

	// -- 3. pull + pin -------------------------------------------------------
	o.logf("pulling %s...", imageTag)
	if err := o.Podman.Pull(imageTag); err != nil {
		return err
	}
	digest, err := o.Podman.ResolveDigest(imageTag)
	if err != nil {
		return err
	}
	o.logf("pinned digest: %s", digest)

	// -- 4. secrets + render + write ----------------------------------------
	// Secret policy:
	//   - fresh init, or --drop-db: generate NEW secrets (new DB, new creds).
	//   - --force WITHOUT --drop-db: PRESERVE the existing secrets from the
	//     current env file, or the running DB (with its old password) would
	//     reject the newly-generated one.
	var pg, turn string
	preserve := o.Force && initialized && !o.DropDB
	if preserve {
		existing, rerr := readEnvSecrets(o.EnvPath)
		if rerr != nil {
			return fmt.Errorf("--force without --drop-db needs the existing secrets, but %s could not be read (%w); re-run with --drop-db to regenerate", o.EnvPath, rerr)
		}
		pg = existing["CHALK_PG_PASSWORD"]
		turn = existing["CHALK_TURN_SECRET"]
		if pg == "" {
			return fmt.Errorf("--force: no CHALK_PG_PASSWORD found in %s to preserve; use --drop-db to regenerate", o.EnvPath)
		}
		o.logf("preserving existing DB/TURN secrets")
	} else {
		if pg, err = genSecret(24); err != nil {
			return err
		}
		if cfg.VoiceEnabled {
			if turn, err = genSecret(24); err != nil {
				return err
			}
		}
	}
	self, err := os.Executable()
	if err != nil || self == "" {
		self = "/usr/local/bin/chalkctl" // sane default for the timer
	} else {
		self, _ = filepath.Abs(self)
	}

	p := InitParams{
		Domain:       cfg.Domain,
		Image:        cfg.Image,
		Version:      o.Version,
		Digest:       digest,
		PostgresTag:  cfg.PostgresTag,
		CaddyTag:     cfg.CaddyTag,
		VoiceEnabled: cfg.VoiceEnabled,
		PGPassword:   pg,
		TurnSecret:   turn,
		ChalkctlPath: self,

		AdminUsername:        cfg.AdminUsername,
		AdminEmail:           cfg.AdminEmail,
		OpenRegistration:     cfg.OpenRegistration,
		VoiceMaxParticipants: cfg.VoiceMaxParticipants,
		AttachMaxBytes:       cfg.AttachMaxBytes,
		GiphyAPIKey:          cfg.GiphyAPIKey,
	}

	ts := time.Now().UTC().Format("20060102-150405")
	backup := func(path string) error {
		if _, err := os.Stat(path); err == nil {
			return os.Rename(path, path+".bak-"+ts)
		}
		return nil
	}

	// env file (0600 -- holds secrets)
	envData, err := renderTemplate("chalk.env", p)
	if err != nil {
		return err
	}
	if err := backup(o.EnvPath); err != nil {
		return err
	}
	if err := writeFile(o.EnvPath, envData, 0o600); err != nil {
		return err
	}
	o.logf("wrote %s (0600)", o.EnvPath)

	// Caddyfile
	caddyData, err := renderTemplate("Caddyfile", p)
	if err != nil {
		return err
	}
	if err := backup(o.CaddyfileAt); err != nil {
		return err
	}
	if err := writeFile(o.CaddyfileAt, caddyData, 0o644); err != nil {
		return err
	}
	o.logf("wrote %s", o.CaddyfileAt)

	// coturn config (voice only): the secret goes in a rendered config FILE
	// read via -c, never a ${...} on the command line (which would expand
	// empty at Quadlet parse time -- see chalk.env.tmpl note).
	if cfg.VoiceEnabled {
		coturnConf := "/etc/chalk/coturn/turnserver.conf"
		coturnData, err := renderTemplate("turnserver.conf", p)
		if err != nil {
			return err
		}
		if err := backup(coturnConf); err != nil {
			return err
		}
		if err := writeFile(coturnConf, coturnData, 0o600); err != nil {
			return err
		}
		o.logf("wrote %s (0600)", coturnConf)
	}

	// quadlet units
	for _, name := range unitTemplates {
		data, err := renderTemplate(name, p)
		if err != nil {
			return err
		}
		dst := filepath.Join(o.QuadletDir, name)
		if err := backup(dst); err != nil {
			return err
		}
		if err := writeFile(dst, data, 0o644); err != nil {
			return err
		}
	}
	o.logf("wrote %d quadlet units to %s", len(unitTemplates), o.QuadletDir)

	// -- 4b. force: stop the running stack so the restart picks up the new
	// units/env, and drop the DB volume if requested (after confirmation
	// above). Fresh init skips this (nothing running).
	if o.Force && initialized {
		voice := cfg.VoiceEnabled
		down := []string{"chalk-caddy.service", "chalkd.service", "chalk-postgres.service"}
		if voice {
			down = append([]string{"chalk-coturn.service"}, down...)
		}
		for _, svc := range down {
			_, _ = Systemctl("reset-failed", svc)
			_, _ = Systemctl("stop", svc)
		}
		o.logf("stopped running stack for re-apply")
		if o.DropDB {
			if _, err := o.Podman.run("volume", "rm", "-f", "chalk-pgdata"); err != nil {
				o.logf("(volume rm chalk-pgdata: %v)", err)
			} else {
				o.logf("dropped chalk-pgdata volume (database wiped; fresh schema on start)")
			}
		}
	}

	// -- 5. bring up ---------------------------------------------------------
	if _, err := Systemctl("daemon-reload"); err != nil {
		return err
	}
	if o.NoStart {
		o.logf("--no-start: units written but not started")
	} else {
		// Start in dependency order; each .container becomes <name>.service.
		order := []string{
			"chalk-postgres.service",
			"chalkd.service",
			"chalk-caddy.service",
		}
		if cfg.VoiceEnabled {
			order = append(order, "chalk-coturn.service")
		}
		for _, svc := range order {
			o.logf("starting %s", svc)
			if _, err := Systemctl("start", svc); err != nil {
				return fmt.Errorf("start %s (check `journalctl -u %s`): %w", svc, svc, err)
			}
		}
	}

	// -- 6. persist config/state + update timer -----------------------------
	if err := cfg.Save(o.ConfigPath); err != nil {
		return err
	}
	st := State{
		Channel:        cfg.Channel,
		CurrentVersion: o.Version,
		CurrentDigest:  digest,
	}
	if err := st.Save(o.StatePath); err != nil {
		return err
	}

	if err := installUpdateTimer(p, o); err != nil {
		// Non-fatal: the stack is up; the operator can add the timer later.
		fmt.Fprintf(o.Out, "  WARNING: could not install auto-update timer: %v\n", err)
	} else {
		o.logf("installed weekly auto-update timer (Sun 04:00)")
	}

	fmt.Fprintf(o.Out, "\ndone. https://%s should serve once Caddy issues its cert.\n", cfg.Domain)
	fmt.Fprintf(o.Out, "admin: open https://%s and enroll a passkey for %q (no password -- passkeys only).\n",
		cfg.Domain, cfg.AdminUsername)
	if cfg.OpenRegistration {
		fmt.Fprintf(o.Out, "note: open registration is ON so friends can sign up; set CHALK_OPEN_REGISTRATION=false + restart once everyone's in.\n")
	}
	fmt.Fprintf(o.Out, "check: systemctl status chalkd chalk-caddy chalk-postgres%s\n",
		voiceStatusHint(cfg.VoiceEnabled))
	return nil
}

func voiceStatusHint(v bool) string {
	if v {
		return " chalk-coturn"
	}
	return ""
}

// installUpdateTimer renders + enables the weekly auto-update systemd timer.
func installUpdateTimer(p InitParams, o InitOptions) error {
	for _, name := range []string{"chalk-update.service", "chalk-update.timer"} {
		data, err := renderTemplate(name, p)
		if err != nil {
			return err
		}
		dst := filepath.Join("/etc/systemd/system", name)
		if err := writeFile(dst, data, 0o644); err != nil {
			return err
		}
	}
	if _, err := Systemctl("daemon-reload"); err != nil {
		return err
	}
	if !o.NoStart {
		if _, err := Systemctl("enable", "--now", "chalk-update.timer"); err != nil {
			return err
		}
	}
	return nil
}

// FirewallHint returns the ports the operator must open (printed by init).
func FirewallHint() string {
	return strings.Join([]string{
		"80/tcp (ACME + redirect)",
		"443/tcp (app)",
		"3478/tcp+udp (coturn)",
		"49160-49200/udp (coturn relay)",
	}, ", ")
}

// readEnvSecrets parses KEY=value lines from an existing env file, returning
// the secret values init needs to preserve on --force (without --drop-db).
func readEnvSecrets(path string) (map[string]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	out := map[string]string{}
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		out[strings.TrimSpace(k)] = strings.TrimSpace(v)
	}
	return out, sc.Err()
}

// promptConfirm asks the operator to type the expected token (shown in the
// prompt) on stdin. Returns true only if the typed line, trimmed, is
// non-empty AND appears as a parenthesised token in the prompt -- i.e. the
// caller embeds the required answer like "...(chalk.example.org) to confirm:".
// This is a deliberately strict "type the domain" confirmation.
func promptConfirm(prompt string) bool {
	fmt.Fprint(os.Stdout, prompt)
	sc := bufio.NewScanner(os.Stdin)
	if !sc.Scan() {
		return false
	}
	typed := strings.TrimSpace(sc.Text())
	if typed == "" {
		return false
	}
	// Extract the token inside the LAST parentheses in the prompt.
	l := strings.LastIndex(prompt, "(")
	r := strings.LastIndex(prompt, ")")
	if l < 0 || r < 0 || r < l {
		return false
	}
	want := prompt[l+1 : r]
	return typed == want
}

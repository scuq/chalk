package chalkctl

import (
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
	if _, ok, err := LoadState(o.StatePath); err != nil {
		return err
	} else if ok {
		return fmt.Errorf("already initialized (%s exists) -- use `chalkctl update` to change the deployed version", o.StatePath)
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
	pg, err := genSecret(24)
	if err != nil {
		return err
	}
	turn := ""
	if cfg.VoiceEnabled {
		if turn, err = genSecret(24); err != nil {
			return err
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

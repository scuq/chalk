package chalkctl

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// ReconfigureTurnOptions configures a coturn-only reconfigure.
type ReconfigureTurnOptions struct {
	Cfg        Config
	EnvPath    string // to read the existing CHALK_TURN_SECRET
	QuadletDir string
	Out        io.Writer
	Verbose    *bool // nil = keep cfg default; non-nil overrides --turn-verbose
}

// ReconfigureTurn re-renders ONLY the coturn config file and unit (picking up
// logging/verbose/image-tag/external-ip changes) and restarts coturn. It does
// not touch chalkd, postgres, caddy, the database, or secrets -- it reuses the
// existing CHALK_TURN_SECRET from the env file so credentials stay valid.
//
// This is the lightweight path for "I changed a coturn setting" without a full
// `init --force` (which restarts the whole stack).
func ReconfigureTurn(o ReconfigureTurnOptions) error {
	if o.Out == nil {
		o.Out = os.Stdout
	}
	if o.EnvPath == "" {
		o.EnvPath = DefaultEnvPath
	}
	if o.QuadletDir == "" {
		o.QuadletDir = DefaultQuadletDir
	}
	if err := RequireRoot(); err != nil {
		return err
	}
	if !o.Cfg.VoiceEnabled {
		return fmt.Errorf("voice is disabled in config; nothing to reconfigure")
	}

	// Reuse the existing TURN secret so minted credentials keep validating.
	secrets, err := readEnvSecrets(o.EnvPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", o.EnvPath, err)
	}
	turnSecret := secrets["CHALK_TURN_SECRET"]
	if turnSecret == "" {
		return fmt.Errorf("no CHALK_TURN_SECRET in %s -- run `chalkctl init --force` instead", o.EnvPath)
	}

	verbose := o.Cfg.TurnVerbose
	if o.Verbose != nil {
		verbose = *o.Verbose
	}

	p := InitParams{
		Domain:      o.Cfg.Domain,
		CoturnTag:   o.Cfg.CoturnTag,
		TurnSecret:  turnSecret,
		TurnVerbose: verbose,
	}

	// coturn config file
	coturnConf := "/etc/chalk/coturn/turnserver.conf"
	confData, err := renderTemplate("turnserver.conf", p)
	if err != nil {
		return err
	}
	if err := writeFile(coturnConf, confData, 0o600); err != nil {
		return err
	}
	fmt.Fprintf(o.Out, "wrote %s\n", coturnConf)

	// coturn unit
	unitData, err := renderTemplate("chalk-coturn.container", p)
	if err != nil {
		return err
	}
	unitPath := filepath.Join(o.QuadletDir, "chalk-coturn.container")
	if err := writeFile(unitPath, unitData, 0o644); err != nil {
		return err
	}
	fmt.Fprintf(o.Out, "wrote %s\n", unitPath)

	// reload + restart just coturn
	if _, err := Systemctl("daemon-reload"); err != nil {
		return err
	}
	_, _ = Systemctl("reset-failed", "chalk-coturn.service")
	if _, err := Systemctl("restart", "chalk-coturn.service"); err != nil {
		return fmt.Errorf("restart coturn (check `journalctl -u chalk-coturn`): %w", err)
	}
	fmt.Fprintln(o.Out, "coturn reconfigured and restarted.")
	fmt.Fprintln(o.Out, "watch it: sudo podman logs -f coturn")
	return nil
}

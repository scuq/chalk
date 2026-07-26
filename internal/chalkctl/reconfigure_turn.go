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
	ConfigPath string // to persist a newly-detected PUBLIC_IP
	QuadletDir string
	Out        io.Writer
	Verbose    *bool  // nil = keep cfg default; non-nil overrides --turn-verbose
	PublicIP   string // "" = use the config's, or detect
}

// ReconfigureTurn re-renders ONLY the coturn unit (picking up
// verbose/image-tag/public-IP changes) and restarts coturn. It does not touch
// chalkd, postgres, caddy, the database, or secrets -- it reuses the existing
// CHALK_TURN_SECRET from the env file so credentials stay valid.
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
	if o.ConfigPath == "" {
		o.ConfigPath = DefaultConfigPath
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

	configured := o.Cfg.PublicIP
	if o.PublicIP != "" {
		configured = o.PublicIP
	}
	logf := func(format string, args ...any) { fmt.Fprintf(o.Out, format+"\n", args...) }
	publicIP, err := ResolvePublicIP(configured, logf)
	if err != nil {
		return err
	}

	p := InitParams{
		Domain:      o.Cfg.Domain,
		CoturnTag:   o.Cfg.CoturnTag,
		TurnSecret:  turnSecret,
		TurnVerbose: verbose,
		PublicIP:    publicIP,
		TurnMinPort: TurnMinPort,
		TurnMaxPort: TurnMaxPort,
	}

	// coturn unit. 0600: the Exec line carries the static auth secret.
	unitData, err := renderTemplate(coturnUnit, p)
	if err != nil {
		return err
	}
	unitPath := filepath.Join(o.QuadletDir, coturnUnit)
	if err := writeFile(unitPath, unitData, unitMode(coturnUnit)); err != nil {
		return err
	}
	fmt.Fprintf(o.Out, "wrote %s\n", unitPath)

	// Persist the address and verbosity actually deployed, so the next
	// `init --force` or `update` re-renders this same unit.
	o.Cfg.PublicIP = publicIP
	o.Cfg.TurnVerbose = verbose
	if err := o.Cfg.Save(o.ConfigPath); err != nil {
		return fmt.Errorf("save %s: %w", o.ConfigPath, err)
	}

	if _, err := os.Stat(coturnLegacyConf); err == nil {
		fmt.Fprintf(o.Out, "note: %s is no longer used (settings are on the unit's Exec line)\n", coturnLegacyConf)
	}

	// reload + restart just coturn
	if _, err := Systemctl("daemon-reload"); err != nil {
		return err
	}
	_, _ = Systemctl("reset-failed", "chalk-coturn.service")
	if _, err := Systemctl("restart", "chalk-coturn.service"); err != nil {
		return fmt.Errorf("restart coturn (check `journalctl -u chalk-coturn`): %w", err)
	}
	fmt.Fprintln(o.Out, "coturn reconfigured and restarted.")
	fmt.Fprintf(o.Out, "relay: %s, ports %d-%d/udp -- the firewall must allow that range,\n",
		publicIP, TurnMinPort, TurnMaxPort)
	fmt.Fprintln(o.Out, "  or allocations succeed and media goes nowhere.")
	fmt.Fprintln(o.Out, "watch it: sudo podman logs -f coturn")
	return nil
}

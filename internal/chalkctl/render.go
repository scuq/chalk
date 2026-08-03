package chalkctl

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"text/template"
)

// InitParams is the data model every template renders against.
type InitParams struct {
	Domain              string
	Image               string // ghcr.io/owner/chalk (no tag)
	Version             string // v0.1.0 (for comment provenance)
	Digest              string // sha256:... (the pin)
	PostgresTag         string
	CaddyTag            string
	CoturnTag           string
	TurnVerbose         bool
	PublicIP            string // coturn listening/relay/external address (IPv4)
	TurnMinPort         int    // coturn UDP relay range, low
	TurnMaxPort         int    // coturn UDP relay range, high
	VoiceEnabled        bool
	PGPassword          string // secret -> env file only
	PGAppPassword       string // secret -> env file only (80-1: chalk_app role)
	PGGuestPassword     string // secret -> env file only (80-1: chalk_guest role)
	TurnSecret          string // secret -> env file only (voice)
	TOTPEncKey          string // secret -> env file only (auth v2 TOTP at-rest key)
	AuthDecoyKey        string // secret -> env file only (81-3: stable prelogin decoys)
	AdminBootstrapToken string // secret -> env file only (one-shot admin claim)
	ChalkctlPath        string // absolute path to this binary (update timer)

	// WebAuthn + admin seed + bootstrap + optional knobs (env file).
	AdminUsername           string
	AdminEmail              string
	OpenRegistration        bool
	VoiceMaxParticipants    int    // 0 = omit (chalkd default)
	AttachMaxBytes          int64  // 0 = omit
	GiphyAPIKey             string // "" = omit
	ThreadActiveWindowHours int    // 0 = omit (chalkd default of 48h)
	LinkPreviewEnabled      bool   // false = write CHALK_LINKPREVIEW_ENABLED=false
	LinkPreviewDomains      string // "" = omit (chalkd's built-in whitelist)

	// 80-5: ephemeral voice channels. 81-3 writes Enabled either way (the
	// server default is now off); the 0-valued knobs are omitted (chalkd
	// defaults).
	EphemeralEnabled     bool
	EphemeralMaxTTLHours int
	EphemeralInviteHours int
	EphemeralMaxGuests   int

	// 72-5: maintenance mode. Caddyfile-only -- when set, Caddy serves the
	// notice instead of proxying chalkd. The message is already HTML-escaped
	// by the time it gets here (see Maint).
	Maintenance        bool
	MaintenanceMessage string

	// 73-2: load pg_stat_statements into Postgres so `chalkctl metrics` can
	// report per-query timings. Off unless the operator asks for it.
	PgStatStatements bool
}

// renderTemplate loads templates/<name>.tmpl from the embedded FS and renders
// it with p. "-" trim markers in the templates handle conditional blocks
// cleanly; Option("missingkey=error") catches typos at render time.
func renderTemplate(name string, p InitParams) ([]byte, error) {
	raw, err := Templates.ReadFile("templates/" + name + ".tmpl")
	if err != nil {
		return nil, fmt.Errorf("read template %s: %w", name, err)
	}
	t, err := template.New(name).Option("missingkey=error").Parse(string(raw))
	if err != nil {
		return nil, fmt.Errorf("parse template %s: %w", name, err)
	}
	var buf bytes.Buffer
	if err := t.Execute(&buf, p); err != nil {
		return nil, fmt.Errorf("render template %s: %w", name, err)
	}
	return buf.Bytes(), nil
}

// unitTemplates lists the Quadlet units + network + volumes written to the
// quadlet dir. Env file, Caddyfile and the timer/service are written
// separately (different destinations / permissions).
var unitTemplates = []string{
	"chalk.network",
	"chalk-pgdata.volume",
	"chalk-blobs.volume",
	"chalk-caddy-data.volume",
	"chalk-caddy-config.volume",
	"chalk-postgres.container",
	"chalkd.container",
	"chalk-caddy.container",
	"chalk-coturn.container",
}

// coturnUnit is the one unit carrying a secret on its Exec line, so it is the
// one unit written 0600. coturnLegacyConf is the config file older deployments
// mounted into the container; nothing reads it any more.
const (
	coturnUnit       = "chalk-coturn.container"
	coturnLegacyConf = "/etc/chalk/coturn/turnserver.conf"
)

// unitMode returns the permissions a quadlet unit is written with.
func unitMode(name string) os.FileMode {
	if name == coturnUnit {
		return 0o600
	}
	return 0o644
}

// writeFile writes data to path (0644 unless mode overrides), creating parent
// dirs. Backs up an existing file to <path>.bak-<ts> first (caller supplies ts
// via the InitPlan for a consistent suffix).
func writeFile(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, mode)
}

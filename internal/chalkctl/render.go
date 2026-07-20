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
	Domain       string
	Image        string // ghcr.io/owner/chalk (no tag)
	Version      string // v0.1.0 (for comment provenance)
	Digest       string // sha256:... (the pin)
	PostgresTag  string
	CaddyTag     string
	VoiceEnabled bool
	PGPassword   string // secret -> env file only
	TurnSecret   string // secret -> env file only (voice)
	ChalkctlPath string // absolute path to this binary (update timer)
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

// writeFile writes data to path (0644 unless mode overrides), creating parent
// dirs. Backs up an existing file to <path>.bak-<ts> first (caller supplies ts
// via the InitPlan for a consistent suffix).
func writeFile(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	return os.WriteFile(path, data, mode)
}

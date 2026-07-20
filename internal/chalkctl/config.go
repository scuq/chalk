package chalkctl

import (
	"bufio"
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Default config/state paths. Overridable via flags for testing.
const (
	DefaultConfigPath = "/etc/chalk/chalkctl.conf"
	DefaultStatePath  = "/var/lib/chalk/state.json"
	DefaultEnvPath    = "/etc/chalk/chalk.env"
	DefaultQuadletDir = "/etc/containers/systemd"
	DefaultCaddyfile  = "/etc/chalk/caddy/Caddyfile"

	DefaultImage       = "ghcr.io/scuq/chalk"
	DefaultPostgresTag = "18-alpine"
	DefaultCaddyTag    = "2-alpine"
	DefaultChannel     = "stable"
)

// Config is the persisted deployment configuration. It is written to
// DefaultConfigPath by `init` and re-read by later commands. The on-disk
// format is stdlib key=value (no TOML dependency): one KEY=value per line,
// '#' comments, blank lines ignored. FLAGS OVERRIDE FILE VALUES -- Load reads
// the file first, then the caller applies flag overlays via the With* setters
// or by constructing flags that default to the file's values.
type Config struct {
	Domain       string // required for init; the public hostname
	Image        string // GHCR image, no tag (DefaultImage)
	PostgresTag  string // postgres image tag (pinned; manual major upgrades)
	CaddyTag     string // caddy image tag
	Channel      string // update channel: stable | <explicit tag>
	VoiceEnabled bool   // Phase 30 voice on/off
	Rootful      bool   // MUST be true for this base; init requires --rootful
}

// DefaultConfig returns the baseline before file/flag overlays.
func DefaultConfig() Config {
	return Config{
		Image:        DefaultImage,
		PostgresTag:  DefaultPostgresTag,
		CaddyTag:     DefaultCaddyTag,
		Channel:      DefaultChannel,
		VoiceEnabled: true,
		Rootful:      false,
	}
}

// LoadConfigFile overlays a key=value file onto cfg. A missing file is not an
// error (returns cfg unchanged) -- init works purely from flags on a fresh
// host. Unknown keys are ignored with a note to stderr rather than failing,
// so a newer config file stays loadable by an older binary.
func LoadConfigFile(cfg Config, path string) (Config, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return cfg, fmt.Errorf("open config %s: %w", path, err)
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	line := 0
	for sc.Scan() {
		line++
		raw := strings.TrimSpace(sc.Text())
		if raw == "" || strings.HasPrefix(raw, "#") {
			continue
		}
		k, v, ok := strings.Cut(raw, "=")
		if !ok {
			return cfg, fmt.Errorf("%s:%d: not KEY=value: %q", path, line, raw)
		}
		k = strings.TrimSpace(k)
		v = strings.TrimSpace(v)
		switch k {
		case "DOMAIN":
			cfg.Domain = v
		case "IMAGE":
			cfg.Image = v
		case "POSTGRES_TAG":
			cfg.PostgresTag = v
		case "CADDY_TAG":
			cfg.CaddyTag = v
		case "CHANNEL":
			cfg.Channel = v
		case "VOICE_ENABLED":
			b, err := strconv.ParseBool(v)
			if err != nil {
				return cfg, fmt.Errorf("%s:%d: VOICE_ENABLED not a bool: %q", path, line, v)
			}
			cfg.VoiceEnabled = b
		case "ROOTFUL":
			b, err := strconv.ParseBool(v)
			if err != nil {
				return cfg, fmt.Errorf("%s:%d: ROOTFUL not a bool: %q", path, line, v)
			}
			cfg.Rootful = b
		default:
			fmt.Fprintf(os.Stderr, "chalkctl: ignoring unknown config key %q (%s:%d)\n", k, path, line)
		}
	}
	return cfg, sc.Err()
}

// Save writes cfg to path as key=value, creating parent dirs (0755) and the
// file 0644 (no secrets live here -- those go to the env file, 0600).
func (c Config) Save(path string) error {
	if err := os.MkdirAll(dirOf(path), 0o755); err != nil {
		return err
	}
	var b strings.Builder
	b.WriteString("# chalk -- chalkctl config (generated). key=value; flags override.\n")
	fmt.Fprintf(&b, "DOMAIN=%s\n", c.Domain)
	fmt.Fprintf(&b, "IMAGE=%s\n", c.Image)
	fmt.Fprintf(&b, "POSTGRES_TAG=%s\n", c.PostgresTag)
	fmt.Fprintf(&b, "CADDY_TAG=%s\n", c.CaddyTag)
	fmt.Fprintf(&b, "CHANNEL=%s\n", c.Channel)
	fmt.Fprintf(&b, "VOICE_ENABLED=%t\n", c.VoiceEnabled)
	fmt.Fprintf(&b, "ROOTFUL=%t\n", c.Rootful)
	return os.WriteFile(path, []byte(b.String()), 0o644)
}

// Validate fails loudly on a config that init could not act on.
func (c Config) Validate() error {
	if strings.TrimSpace(c.Domain) == "" {
		return fmt.Errorf("domain is required (--domain or DOMAIN=)")
	}
	if strings.ContainsAny(c.Domain, " /:") {
		return fmt.Errorf("domain %q looks wrong (no scheme/port/spaces)", c.Domain)
	}
	if !c.Rootful {
		return fmt.Errorf("this base requires rootful podman: pass --rootful (rootless is not supported for binding 80/443/3478)")
	}
	if c.Image == "" || c.PostgresTag == "" || c.CaddyTag == "" {
		return fmt.Errorf("image and image tags must be non-empty")
	}
	return nil
}

func dirOf(path string) string {
	i := strings.LastIndex(path, "/")
	if i <= 0 {
		return "."
	}
	return path[:i]
}

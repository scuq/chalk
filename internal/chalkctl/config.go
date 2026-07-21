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
	DefaultCoturnTag   = "4.14.0-r0-alpine"
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
	CoturnTag    string // coturn image tag (alpine)
	TurnVerbose  bool   // coturn --verbose logging
	Channel      string // update channel: stable | <explicit tag>
	VoiceEnabled bool   // Phase 30 voice on/off
	Rootful      bool   // MUST be true for this base; init requires --rootful

	// WebAuthn / passkeys. RPID MUST equal the domain or browsers reject
	// passkey enrollment; origins must be the https origin (auto-derived
	// from Domain, since chalkd sits behind Caddy and can't infer it).
	AdminUsername string // seeds the admin row on first boot; enroll a passkey onto it
	AdminEmail    string // admin email (first boot)

	// Bootstrap: let anyone register so friends can join. TIGHTEN to false
	// once everyone's in (then use invites).
	OpenRegistration bool

	// Optional operational knobs (0/"" = leave chalkd's own default).
	VoiceMaxParticipants int    // CHALK_VOICE_MAX_PARTICIPANTS (mesh cap)
	AttachMaxBytes       int64  // CHALK_ATTACH_MAX_BYTES (upload cap; disk guard)
	GiphyAPIKey          string // CHALK_GIPHY_API_KEY (GIF picker; optional)
}

// DefaultConfig returns the baseline before file/flag overlays.
func DefaultConfig() Config {
	return Config{
		Image:            DefaultImage,
		PostgresTag:      DefaultPostgresTag,
		CaddyTag:         DefaultCaddyTag,
		CoturnTag:        DefaultCoturnTag,
		TurnVerbose:      true,
		Channel:          DefaultChannel,
		VoiceEnabled:     true,
		Rootful:          false,
		OpenRegistration: true, // bootstrap: let friends register; tighten later
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
		case "COTURN_TAG":
			cfg.CoturnTag = v
		case "TURN_VERBOSE":
			b, err := strconv.ParseBool(v)
			if err != nil {
				return cfg, fmt.Errorf("%s:%d: TURN_VERBOSE not a bool: %q", path, line, v)
			}
			cfg.TurnVerbose = b
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
		case "ADMIN_USERNAME":
			cfg.AdminUsername = v
		case "ADMIN_EMAIL":
			cfg.AdminEmail = v
		case "OPEN_REGISTRATION":
			b, err := strconv.ParseBool(v)
			if err != nil {
				return cfg, fmt.Errorf("%s:%d: OPEN_REGISTRATION not a bool: %q", path, line, v)
			}
			cfg.OpenRegistration = b
		case "VOICE_MAX_PARTICIPANTS":
			n, err := strconv.Atoi(v)
			if err != nil {
				return cfg, fmt.Errorf("%s:%d: VOICE_MAX_PARTICIPANTS not an int: %q", path, line, v)
			}
			cfg.VoiceMaxParticipants = n
		case "ATTACH_MAX_BYTES":
			n, err := strconv.ParseInt(v, 10, 64)
			if err != nil {
				return cfg, fmt.Errorf("%s:%d: ATTACH_MAX_BYTES not an int: %q", path, line, v)
			}
			cfg.AttachMaxBytes = n
		case "GIPHY_API_KEY":
			cfg.GiphyAPIKey = v
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
	fmt.Fprintf(&b, "COTURN_TAG=%s\n", c.CoturnTag)
	fmt.Fprintf(&b, "TURN_VERBOSE=%t\n", c.TurnVerbose)
	fmt.Fprintf(&b, "CHANNEL=%s\n", c.Channel)
	fmt.Fprintf(&b, "VOICE_ENABLED=%t\n", c.VoiceEnabled)
	fmt.Fprintf(&b, "ROOTFUL=%t\n", c.Rootful)
	fmt.Fprintf(&b, "ADMIN_USERNAME=%s\n", c.AdminUsername)
	fmt.Fprintf(&b, "ADMIN_EMAIL=%s\n", c.AdminEmail)
	fmt.Fprintf(&b, "OPEN_REGISTRATION=%t\n", c.OpenRegistration)
	if c.VoiceMaxParticipants > 0 {
		fmt.Fprintf(&b, "VOICE_MAX_PARTICIPANTS=%d\n", c.VoiceMaxParticipants)
	}
	if c.AttachMaxBytes > 0 {
		fmt.Fprintf(&b, "ATTACH_MAX_BYTES=%d\n", c.AttachMaxBytes)
	}
	// GIPHY_API_KEY is intentionally NOT written here: this config file is
	// 0644, and the key belongs only in the 0600 env file. It is supplied
	// per-init via --giphy-api-key when needed.
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
	if strings.TrimSpace(c.AdminUsername) == "" {
		return fmt.Errorf("admin username is required (--admin-username): it seeds the admin row you enroll a passkey onto")
	}
	if strings.TrimSpace(c.AdminEmail) == "" {
		return fmt.Errorf("admin email is required (--admin-email)")
	}
	if !strings.Contains(c.AdminEmail, "@") {
		return fmt.Errorf("admin email %q looks wrong", c.AdminEmail)
	}
	if c.Image == "" || c.PostgresTag == "" || c.CaddyTag == "" || c.CoturnTag == "" {
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

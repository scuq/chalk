// Package config loads chalk's runtime configuration from env and flags.
//
// Precedence (low → high): defaults, environment variables (CHALK_*), CLI flags.
package config

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Config is the immutable runtime configuration for a chalkd process.
type Config struct {
	Listen string
	DBURL  string

	TLSMode          string
	TLSCertFile      string
	TLSKeyFile       string
	AutocertHost     string
	AutocertCacheDir string

	BlobDir string

	LogLevel  string
	LogFormat string

	ShutdownGrace time.Duration
	InstanceID    string

	MigrateOnly bool

	// ListenInfoFile, when non-empty, receives "host:port\n" written by the
	// server after the listener binds. Useful for tests and orchestrators
	// that need the actual port when "0" was requested.
	ListenInfoFile string

	// PrintListen, when true, also prints "listening on host:port" to stdout
	// after binding. Default true when running interactively.
	PrintListen bool

	// Phase 09b: auth.
	//
	// RPID is the WebAuthn Relying Party ID. For browser ceremonies
	// this must be the effective domain (e.g. "localhost" in dev,
	// "chalk.example.com" in prod). Browsers reject credentials whose
	// RP ID does not match the page origin's effective domain.
	//
	// CHALK_RP_ID, default "localhost".
	RPID string

	// RPName is the human-readable RP name shown to the user in the
	// authenticator's UI.
	//
	// CHALK_RP_NAME, default "chalk".
	RPName string

	// RPOrigins is the comma-separated list of allowed origins for
	// WebAuthn ceremonies. Each entry must include scheme and (if
	// non-default) port.
	//
	// CHALK_RP_ORIGINS, default derived from the listen address and
	// TLS mode at server startup. Set explicitly for multi-host
	// deploys.
	RPOrigins string

	// AdminUsername, AdminEmail, AdminDisplayName seed the admin user
	// on first startup (when no admin row exists). All three are
	// consulted only the first time chalkd boots against an empty
	// users table; once an admin exists, these env vars are ignored.
	//
	// CHALK_ADMIN_USERNAME (required if no admin exists),
	// CHALK_ADMIN_EMAIL (required if no admin exists),
	// CHALK_ADMIN_DISPLAY_NAME (optional; defaults to username).
	//
	// Validation of these fields happens at admin-bootstrap time, not
	// at Config.Validate time (we don't want chalkd to refuse to
	// start just because the operator forgot the env vars on a
	// subsequent boot).
	AdminUsername    string
	AdminEmail       string
	AdminDisplayName string

	// OpenRegistration, when true, lets POST /api/auth/register/begin
	// accept requests without an invite token. Off by default;
	// intended for bootstrap of a self-hosted instance (admin
	// creates their own account before invites exist) and dev.
	//
	// CHALK_OPEN_REGISTRATION, default false. The auth package also
	// reads the env var directly at request time via
	// auth.IsOpenRegistration(); this Config field carries the flag
	// resolution for diagnostic logging at startup.
	OpenRegistration bool

	// Governance holds the server-wide DEFAULTS for per-channel governance
	// config (gov-1a). A channel snapshots these into its own columns at
	// creation; changing an env var therefore only affects channels created
	// afterward. The per-channel columns remain the source of truth at tally
	// time. See GovernanceDefaults for the individual CHALK_* knobs.
	Governance GovernanceDefaults

	// att-1: server-wide attachment limits (CHALK_ATTACH_*). See
	// AttachmentConfig in attachments.go.
	Attachments AttachmentConfig

	// att-4: Giphy search-proxy settings (CHALK_GIPHY_*). See GiphyConfig
	// in giphy.go. Disabled unless CHALK_GIPHY_API_KEY is set.
	Giphy GiphyConfig

	// 30-1: Phase 30 voice/video knobs (CHALK_VOICE_* / CHALK_TURN_* /
	// CHALK_STUN_URLS). See VoiceConfig for the individual knobs.
	Voice VoiceConfig
}

// GovernanceDefaults are the server-wide default governance parameters,
// configurable via CHALK_* env vars and seeded into each new channel's
// columns at creation time (gov-1a / spec H14).
type GovernanceDefaults struct {
	// DefaultMode is the governance_mode new channels start in.
	// CHALK_GOVERNANCE_DEFAULT_MODE, "dictator" | "democratic", default "dictator".
	DefaultMode string
	// VoteWindowDays is the activity window for voter eligibility: a member is
	// eligible only if active and seen within this many days.
	// CHALK_VOTE_WINDOW_DAYS, default 30.
	VoteWindowDays int
	// VoteExpiryHours is how long a proposal stays open before it expires
	// (unresolved -> failed). CHALK_VOTE_EXPIRY_HOURS, default 168 (7 days).
	VoteExpiryHours int
	// MinEligible is the absolute floor of snapshot voters required to even
	// OPEN a proposal. CHALK_VOTE_MIN_ELIGIBLE, default 3.
	MinEligible int
	// QuorumPercent is the turnout (% of the frozen snapshot that must cast a
	// ballot) required for a proposal to pass. CHALK_VOTE_QUORUM_PERCENT,
	// default 50.
	QuorumPercent int
	// PassPercent is the share of *voters* that must vote yes for a normal
	// pass (strictly greater than this percent => >50 is a strict majority).
	// CHALK_VOTE_PASS_PERCENT, default 50.
	PassPercent int
	// SupermajorityPercent is the higher bar for a democratic->dictator
	// set_mode proposal (dissolving democracy). CHALK_VOTE_SUPERMAJORITY_PERCENT,
	// default 67.
	SupermajorityPercent int
	// ReproposeCooldownHours is how long after a proposal FAILS the same
	// (channel, type, target) is barred from being re-proposed (anti-spam /
	// anti-harassment). CHALK_VOTE_REPROPOSE_COOLDOWN_HOURS, default 168.
	ReproposeCooldownHours int
}

func Default() Config {
	return Config{
		Listen:           ":8443",
		DBURL:            "",
		TLSMode:          "selfsigned",
		AutocertCacheDir: "/var/lib/chalk/autocert",
		BlobDir:          "/var/lib/chalk/blobs",
		LogLevel:         "info",
		LogFormat:        "console",
		ShutdownGrace:    20 * time.Second,
		PrintListen:      true,

		// Phase 09b defaults.
		RPID:   "localhost",
		RPName: "chalk",
		// RPOrigins empty by default; the server fills it from Listen +
		// TLSMode when not explicitly set. Empty here lets us tell
		// "operator set this" from "use the default" cleanly.

		// gov-1a: governance defaults (spec H14). Seeded into each new
		// channel's columns at creation; per-channel columns then win.
		Governance: GovernanceDefaults{
			DefaultMode:            "dictator",
			VoteWindowDays:         30,
			VoteExpiryHours:        168,
			MinEligible:            3,
			QuorumPercent:          50,
			PassPercent:            50,
			SupermajorityPercent:   67,
			ReproposeCooldownHours: 168,
		},

		// att-1: attachment limits.
		Attachments: defaultAttachmentConfig(),

		// att-4: Giphy search proxy.
		Giphy: defaultGiphyConfig(),

		// 30-1: voice/video.
		Voice: defaultVoiceConfig(),
	}
}

func Load(args []string) (Config, error) {
	c := Default()
	c.applyEnv()

	fs := flag.NewFlagSet("chalkd", flag.ContinueOnError)
	fs.StringVar(&c.Listen, "listen", c.Listen, "address to listen on (host:port; port may be 0 for random)")
	fs.StringVar(&c.DBURL, "db-url", c.DBURL, "postgres connection string (CHALK_DB_URL)")
	fs.StringVar(&c.TLSMode, "tls-mode", c.TLSMode, "tls mode: off|selfsigned|file|autocert")
	fs.StringVar(&c.TLSCertFile, "tls-cert", c.TLSCertFile, "path to TLS certificate")
	fs.StringVar(&c.TLSKeyFile, "tls-key", c.TLSKeyFile, "path to TLS private key")
	fs.StringVar(&c.AutocertHost, "autocert-host", c.AutocertHost, "host for autocert")
	fs.StringVar(&c.AutocertCacheDir, "autocert-cache", c.AutocertCacheDir, "autocert cache directory")
	fs.StringVar(&c.BlobDir, "blob-dir", c.BlobDir, "directory for encrypted attachments")
	fs.StringVar(&c.LogLevel, "log-level", c.LogLevel, "log level: debug|info|warn|error")
	fs.StringVar(&c.LogFormat, "log-format", c.LogFormat, "log format: console|json")
	fs.DurationVar(&c.ShutdownGrace, "shutdown-grace", c.ShutdownGrace, "graceful shutdown timeout")
	fs.StringVar(&c.InstanceID, "instance-id", c.InstanceID, "this instance's ID (auto if empty)")
	fs.BoolVar(&c.MigrateOnly, "migrate-only", c.MigrateOnly, "apply migrations and exit")
	fs.StringVar(&c.ListenInfoFile, "listen-info-file", c.ListenInfoFile,
		"if set, write 'host:port\\n' to this path after binding the listener")
	fs.BoolVar(&c.PrintListen, "print-listen", c.PrintListen,
		"print 'listening on host:port' to stdout after binding (default true)")

	// Phase 09b flags.
	fs.StringVar(&c.RPID, "rp-id", c.RPID, "WebAuthn RP ID (CHALK_RP_ID)")
	fs.StringVar(&c.RPName, "rp-name", c.RPName, "WebAuthn RP display name (CHALK_RP_NAME)")
	fs.StringVar(&c.RPOrigins, "rp-origins", c.RPOrigins,
		"comma-separated allowed origins (CHALK_RP_ORIGINS); empty = derive from listen/tls")
	fs.StringVar(&c.AdminUsername, "admin-username", c.AdminUsername,
		"admin username on first run (CHALK_ADMIN_USERNAME)")
	fs.StringVar(&c.AdminEmail, "admin-email", c.AdminEmail,
		"admin email on first run (CHALK_ADMIN_EMAIL)")
	fs.StringVar(&c.AdminDisplayName, "admin-display-name", c.AdminDisplayName,
		"admin display name on first run (CHALK_ADMIN_DISPLAY_NAME)")
	fs.BoolVar(&c.OpenRegistration, "open-registration", c.OpenRegistration,
		"allow registration without an invite token (CHALK_OPEN_REGISTRATION)")

	showVersion := fs.Bool("version", false, "print version and exit")
	fs.Usage = func() {
		fmt.Fprintf(fs.Output(), "Usage: chalkd [flags]\n\nFlags:\n")
		fs.PrintDefaults()
	}

	if err := fs.Parse(args); err != nil {
		return c, err
	}
	if *showVersion {
		return c, ErrVersionRequested
	}
	if err := c.Validate(); err != nil {
		return c, err
	}
	return c, nil
}

var ErrVersionRequested = errors.New("version requested")

func (c *Config) applyEnv() {
	binds := []struct {
		dst *string
		key string
	}{
		{&c.Listen, "CHALK_LISTEN"},
		{&c.DBURL, "CHALK_DB_URL"},
		{&c.TLSMode, "CHALK_TLS_MODE"},
		{&c.TLSCertFile, "CHALK_TLS_CERT"},
		{&c.TLSKeyFile, "CHALK_TLS_KEY"},
		{&c.AutocertHost, "CHALK_AUTOCERT_HOST"},
		{&c.AutocertCacheDir, "CHALK_AUTOCERT_CACHE"},
		{&c.BlobDir, "CHALK_BLOB_DIR"},
		{&c.LogLevel, "CHALK_LOG_LEVEL"},
		{&c.LogFormat, "CHALK_LOG_FORMAT"},
		{&c.InstanceID, "CHALK_INSTANCE_ID"},
		{&c.ListenInfoFile, "CHALK_LISTEN_INFO_FILE"},

		// Phase 09b auth bindings.
		{&c.RPID, "CHALK_RP_ID"},
		{&c.RPName, "CHALK_RP_NAME"},
		{&c.RPOrigins, "CHALK_RP_ORIGINS"},
		{&c.AdminUsername, "CHALK_ADMIN_USERNAME"},
		{&c.AdminEmail, "CHALK_ADMIN_EMAIL"},
		{&c.AdminDisplayName, "CHALK_ADMIN_DISPLAY_NAME"},
	}
	for _, b := range binds {
		if v := os.Getenv(b.key); v != "" {
			*b.dst = v
		}
	}
	if v := os.Getenv("CHALK_SHUTDOWN_GRACE"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			c.ShutdownGrace = d
		}
	}
	// Phase 09b sub-step 3: open-registration flag.
	if v := os.Getenv("CHALK_OPEN_REGISTRATION"); v != "" {
		c.OpenRegistration = parseBool(v)
	}

	// gov-1a: governance defaults (spec H14). String mode + int knobs.
	if v := os.Getenv("CHALK_GOVERNANCE_DEFAULT_MODE"); v != "" {
		c.Governance.DefaultMode = strings.ToLower(strings.TrimSpace(v))
	}
	govInts := []struct {
		dst *int
		key string
	}{
		{&c.Governance.VoteWindowDays, "CHALK_VOTE_WINDOW_DAYS"},
		{&c.Governance.VoteExpiryHours, "CHALK_VOTE_EXPIRY_HOURS"},
		{&c.Governance.MinEligible, "CHALK_VOTE_MIN_ELIGIBLE"},
		{&c.Governance.QuorumPercent, "CHALK_VOTE_QUORUM_PERCENT"},
		{&c.Governance.PassPercent, "CHALK_VOTE_PASS_PERCENT"},
		{&c.Governance.SupermajorityPercent, "CHALK_VOTE_SUPERMAJORITY_PERCENT"},
		{&c.Governance.ReproposeCooldownHours, "CHALK_VOTE_REPROPOSE_COOLDOWN_HOURS"},
	}
	for _, b := range govInts {
		if n, ok := envInt(b.key); ok {
			*b.dst = n
		}
	}

	// att-1: attachment limits from CHALK_ATTACH_* env vars.
	c.Attachments.applyEnv()

	// att-4: Giphy search proxy from CHALK_GIPHY_* env vars.
	c.Giphy.applyEnv()

	// 30-1: voice/video from CHALK_VOICE_*/CHALK_TURN_* env vars.
	c.Voice.applyEnv()
}

// envInt reads an integer env var. Returns (0, false) when unset or
// unparseable so callers keep their existing default rather than silently
// zeroing it.
func envInt(key string) (int, bool) {
	v := os.Getenv(key)
	if v == "" {
		return 0, false
	}
	n, err := strconv.Atoi(strings.TrimSpace(v))
	if err != nil {
		return 0, false
	}
	return n, true
}

// parseBool accepts the same truthy strings as auth.IsOpenRegistration
// and auth.IsDevMode (1, true, yes, on; case-insensitive). Anything
// else is false. Returns the original c.OpenRegistration would be set
// to (false for empty/unset; caller is expected to guard on env presence).
func parseBool(s string) bool {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func (c Config) Validate() error {
	switch c.TLSMode {
	case "off", "selfsigned":
	case "file":
		if c.TLSCertFile == "" || c.TLSKeyFile == "" {
			return errors.New("tls-mode=file requires --tls-cert and --tls-key")
		}
	case "autocert":
		if c.AutocertHost == "" {
			return errors.New("tls-mode=autocert requires --autocert-host")
		}
	default:
		return fmt.Errorf("invalid tls-mode: %q", c.TLSMode)
	}

	switch c.LogLevel {
	case "debug", "info", "warn", "error":
	default:
		return fmt.Errorf("invalid log-level: %q", c.LogLevel)
	}
	switch c.LogFormat {
	case "console", "json":
	default:
		return fmt.Errorf("invalid log-format: %q", c.LogFormat)
	}
	if c.ShutdownGrace < 0 {
		return errors.New("shutdown-grace must be >= 0")
	}
	if c.Listen == "" {
		return errors.New("listen address must not be empty")
	}
	if _, p, err := splitHostPort(c.Listen); err != nil {
		return fmt.Errorf("invalid listen address %q: %w", c.Listen, err)
	} else if _, perr := strconv.Atoi(p); perr != nil {
		return fmt.Errorf("invalid port in listen address %q (port must be numeric, including 0 for random)", c.Listen)
	}

	// Phase 09b: RPID and RPName must be non-empty (defaults cover
	// this, but a user clearing them via env should fail loudly).
	if c.RPID == "" {
		return errors.New("rp-id must not be empty")
	}
	if c.RPName == "" {
		return errors.New("rp-name must not be empty")
	}
	// RPOrigins is allowed to be empty (server derives it from
	// listen/tls); we don't validate format here because the auth
	// service will reject malformed values at construction time.

	// gov-1a: governance defaults. Fail loudly on nonsense rather than
	// silently running a channel with an un-passable or zero-window vote.
	g := c.Governance
	if g.DefaultMode != "dictator" && g.DefaultMode != "democratic" {
		return fmt.Errorf("invalid CHALK_GOVERNANCE_DEFAULT_MODE: %q (want dictator|democratic)", g.DefaultMode)
	}
	if g.VoteWindowDays <= 0 {
		return errors.New("CHALK_VOTE_WINDOW_DAYS must be > 0")
	}
	if g.VoteExpiryHours <= 0 {
		return errors.New("CHALK_VOTE_EXPIRY_HOURS must be > 0")
	}
	if g.ReproposeCooldownHours <= 0 {
		return errors.New("CHALK_VOTE_REPROPOSE_COOLDOWN_HOURS must be > 0")
	}
	if g.MinEligible < 1 {
		return errors.New("CHALK_VOTE_MIN_ELIGIBLE must be >= 1")
	}
	for _, pc := range []struct {
		name string
		val  int
	}{
		{"CHALK_VOTE_QUORUM_PERCENT", g.QuorumPercent},
		{"CHALK_VOTE_PASS_PERCENT", g.PassPercent},
		{"CHALK_VOTE_SUPERMAJORITY_PERCENT", g.SupermajorityPercent},
	} {
		if pc.val < 1 || pc.val > 100 {
			return fmt.Errorf("%s must be in 1..100 (got %d)", pc.name, pc.val)
		}
	}

	// att-1: attachment limits.
	if err := c.Attachments.Validate(); err != nil {
		return err
	}

	// att-4: Giphy search proxy.
	if err := c.Giphy.Validate(); err != nil {
		return err
	}

	// 30-1: voice/video.
	if err := c.Voice.Validate(); err != nil {
		return err
	}

	return nil
}

func splitHostPort(addr string) (string, string, error) {
	for i := len(addr) - 1; i >= 0; i-- {
		if addr[i] == ':' {
			return addr[:i], addr[i+1:], nil
		}
	}
	return "", "", errors.New("missing port")
}

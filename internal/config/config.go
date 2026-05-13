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

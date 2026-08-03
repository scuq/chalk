package config

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestDefault(t *testing.T) {
	c := Default()
	if c.Listen != ":8443" {
		t.Fatalf("expected default listen :8443, got %q", c.Listen)
	}
	if c.TLSMode != "selfsigned" {
		t.Fatalf("expected default tls-mode selfsigned, got %q", c.TLSMode)
	}
	if c.LogLevel != "info" {
		t.Fatalf("expected default log-level info, got %q", c.LogLevel)
	}
}

func TestLoadDefaults(t *testing.T) {
	t.Setenv("CHALK_LISTEN", "")
	t.Setenv("CHALK_DB_URL", "")
	t.Setenv("CHALK_TLS_MODE", "")
	t.Setenv("CHALK_LOG_LEVEL", "")
	t.Setenv("CHALK_LOG_FORMAT", "")
	t.Setenv("CHALK_SHUTDOWN_GRACE", "")
	c, err := Load(nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.Listen != ":8443" {
		t.Fatalf("listen: %q", c.Listen)
	}
}

func TestLoadEnvOverrides(t *testing.T) {
	t.Setenv("CHALK_LISTEN", "127.0.0.1:9000")
	t.Setenv("CHALK_TLS_MODE", "off")
	t.Setenv("CHALK_LOG_LEVEL", "debug")
	t.Setenv("CHALK_LOG_FORMAT", "json")
	t.Setenv("CHALK_SHUTDOWN_GRACE", "5s")
	c, err := Load(nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.Listen != "127.0.0.1:9000" {
		t.Fatalf("listen: %q", c.Listen)
	}
	if c.TLSMode != "off" {
		t.Fatalf("tls-mode: %q", c.TLSMode)
	}
	if c.LogLevel != "debug" {
		t.Fatalf("log-level: %q", c.LogLevel)
	}
	if c.LogFormat != "json" {
		t.Fatalf("log-format: %q", c.LogFormat)
	}
	if c.ShutdownGrace != 5*time.Second {
		t.Fatalf("shutdown-grace: %v", c.ShutdownGrace)
	}
}

func TestLoadFlagsBeatEnv(t *testing.T) {
	t.Setenv("CHALK_LISTEN", "127.0.0.1:9000")
	c, err := Load([]string{"--listen", ":7777"})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.Listen != ":7777" {
		t.Fatalf("expected flag to win: %q", c.Listen)
	}
}

func TestLoadVersionFlag(t *testing.T) {
	_, err := Load([]string{"--version"})
	if !errors.Is(err, ErrVersionRequested) {
		t.Fatalf("expected ErrVersionRequested, got %v", err)
	}
}

func TestValidateBadTLSMode(t *testing.T) {
	c := Default()
	c.TLSMode = "weird"
	if err := c.Validate(); err == nil {
		t.Fatal("expected validation error for bad tls-mode")
	}
}

func TestValidateAutocertRequiresHost(t *testing.T) {
	c := Default()
	c.TLSMode = "autocert"
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "autocert-host") {
		t.Fatalf("expected autocert-host error, got %v", err)
	}
}

func TestValidateFileTLSRequiresPaths(t *testing.T) {
	c := Default()
	c.TLSMode = "file"
	if err := c.Validate(); err == nil {
		t.Fatal("expected error when tls-mode=file without paths")
	}
}

func TestValidateBadLogLevel(t *testing.T) {
	c := Default()
	c.LogLevel = "spammy"
	if err := c.Validate(); err == nil {
		t.Fatal("expected error for bad log level")
	}
}

func TestValidateBadListen(t *testing.T) {
	c := Default()
	c.Listen = "no-port-here"
	if err := c.Validate(); err == nil {
		t.Fatal("expected error for malformed listen")
	}
}

// 80-5: ephemeral knobs -- defaults, env overlay, and the 24 h invite hard cap.
func TestEphemeralConfig(t *testing.T) {
	c, err := Load(nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	e := c.Ephemeral
	if !e.Enabled || e.MaxTTLHours != 720 || e.InviteMaxTTLHours != 24 || e.MaxGuests != 8 {
		t.Fatalf("defaults: %+v", e)
	}
	if c.DBURLGuest != "" {
		t.Fatalf("DBURLGuest default should be empty, got %q", c.DBURLGuest)
	}

	t.Setenv("CHALK_EPHEMERAL_ENABLED", "false")
	t.Setenv("CHALK_EPHEMERAL_MAX_TTL_HOURS", "96")
	t.Setenv("CHALK_EPHEMERAL_INVITE_MAX_TTL_HOURS", "12")
	t.Setenv("CHALK_EPHEMERAL_MAX_GUESTS", "3")
	t.Setenv("CHALK_DB_URL_GUEST", "postgres://chalk_guest:pw@localhost/chalk")
	c, err = Load(nil)
	if err != nil {
		t.Fatalf("Load with env: %v", err)
	}
	e = c.Ephemeral
	if e.Enabled || e.MaxTTLHours != 96 || e.InviteMaxTTLHours != 12 || e.MaxGuests != 3 {
		t.Fatalf("env overlay: %+v", e)
	}
	if c.DBURLGuest != "postgres://chalk_guest:pw@localhost/chalk" {
		t.Fatalf("DBURLGuest: %q", c.DBURLGuest)
	}
}

func TestEphemeralInviteTTLHardCap(t *testing.T) {
	t.Setenv("CHALK_EPHEMERAL_INVITE_MAX_TTL_HOURS", "25")
	if _, err := Load(nil); err == nil {
		t.Fatal("invite TTL above 24 h must refuse to load")
	}
	// The cap is only enforced while the feature is on: a disabled feature
	// with a stale bad knob must not brick the boot.
	t.Setenv("CHALK_EPHEMERAL_ENABLED", "false")
	if _, err := Load(nil); err != nil {
		t.Fatalf("disabled feature must ignore the knob: %v", err)
	}
}

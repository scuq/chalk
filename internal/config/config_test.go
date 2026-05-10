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

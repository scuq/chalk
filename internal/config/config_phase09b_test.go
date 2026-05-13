package config

import (
	"strings"
	"testing"
)

// Phase 09b adds RPID/RPName/RPOrigins and AdminUsername/Email/DisplayName
// to Config. These tests exercise the env-var bindings and validation
// rules added in sub-step 2.
//
// The existing config_test.go covers TLSMode / LogLevel / Listen and
// the shared flag-vs-env precedence. We don't duplicate those here.

func TestDefault09bAuthFields(t *testing.T) {
	c := Default()
	if c.RPID != "localhost" {
		t.Errorf("default RPID = %q, want localhost", c.RPID)
	}
	if c.RPName != "chalk" {
		t.Errorf("default RPName = %q, want chalk", c.RPName)
	}
	if c.RPOrigins != "" {
		t.Errorf("default RPOrigins = %q, want empty (server derives)", c.RPOrigins)
	}
	if c.AdminUsername != "" || c.AdminEmail != "" || c.AdminDisplayName != "" {
		t.Errorf("admin fields should default to empty: u=%q e=%q d=%q",
			c.AdminUsername, c.AdminEmail, c.AdminDisplayName)
	}
}

func TestLoadEnv09bAuth(t *testing.T) {
	t.Setenv("CHALK_RP_ID", "chalk.example.com")
	t.Setenv("CHALK_RP_NAME", "Chalk Production")
	t.Setenv("CHALK_RP_ORIGINS", "https://chalk.example.com,https://www.chalk.example.com")
	t.Setenv("CHALK_ADMIN_USERNAME", "scuq")
	t.Setenv("CHALK_ADMIN_EMAIL", "scuq@kagesintern.at")
	t.Setenv("CHALK_ADMIN_DISPLAY_NAME", "Scuq")
	t.Setenv("CHALK_TLS_MODE", "off")

	c, err := Load(nil)
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.RPID != "chalk.example.com" {
		t.Errorf("RPID = %q", c.RPID)
	}
	if c.RPName != "Chalk Production" {
		t.Errorf("RPName = %q", c.RPName)
	}
	if c.RPOrigins != "https://chalk.example.com,https://www.chalk.example.com" {
		t.Errorf("RPOrigins = %q", c.RPOrigins)
	}
	if c.AdminUsername != "scuq" {
		t.Errorf("AdminUsername = %q", c.AdminUsername)
	}
	if c.AdminEmail != "scuq@kagesintern.at" {
		t.Errorf("AdminEmail = %q", c.AdminEmail)
	}
	if c.AdminDisplayName != "Scuq" {
		t.Errorf("AdminDisplayName = %q", c.AdminDisplayName)
	}
}

func TestLoadFlags09bBeatEnv(t *testing.T) {
	t.Setenv("CHALK_RP_ID", "from-env")
	t.Setenv("CHALK_TLS_MODE", "off")
	c, err := Load([]string{"--rp-id", "from-flag"})
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if c.RPID != "from-flag" {
		t.Errorf("flag should win: RPID = %q", c.RPID)
	}
}

func TestValidate09bAuthFields(t *testing.T) {
	// Empty RPID is rejected.
	c := Default()
	c.RPID = ""
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "rp-id") {
		t.Errorf("empty RPID: got %v", err)
	}
	// Empty RPName is rejected.
	c = Default()
	c.RPName = ""
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "rp-name") {
		t.Errorf("empty RPName: got %v", err)
	}
	// Empty RPOrigins is allowed (server fills in).
	c = Default()
	c.RPOrigins = ""
	if err := c.Validate(); err != nil {
		t.Errorf("empty RPOrigins should be OK at config layer: %v", err)
	}
	// Admin* fields are validated at bootstrap time, not at Config.Validate.
	c = Default()
	c.AdminUsername = ""
	if err := c.Validate(); err != nil {
		t.Errorf("empty AdminUsername should pass Config.Validate: %v", err)
	}
}

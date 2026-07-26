package chalkctl

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 42-5: the knob must survive LoadConfigFile -> Save, which is what makes
// `chalkctl init --force` with no flag preserve it. And it must be OMITTED from
// the env file when unset, so chalkd's own 48h default applies -- unlike a
// secret, an absent knob is the correct state and needs no update-time backfill.
func TestThreadActiveWindowRoundTrips(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "chalkctl.conf")

	c := DefaultConfig()
	c.Domain = "chat.example.org"
	c.AdminUsername = "admin"
	c.AdminEmail = "a@example.org"
	c.ThreadActiveWindowHours = 72
	if err := c.Save(path); err != nil {
		t.Fatalf("Save: %v", err)
	}
	raw, _ := os.ReadFile(path)
	if !strings.Contains(string(raw), "THREAD_ACTIVE_WINDOW_HOURS=72") {
		t.Fatalf("Save dropped the knob:\n%s", raw)
	}
	back, err := LoadConfigFile(DefaultConfig(), path)
	if err != nil {
		t.Fatalf("LoadConfigFile: %v", err)
	}
	if back.ThreadActiveWindowHours != 72 {
		t.Errorf("round-trip = %d, want 72", back.ThreadActiveWindowHours)
	}

	// Unset -> omitted from both the config file and the env file.
	c.ThreadActiveWindowHours = 0
	if err := c.Save(path); err != nil {
		t.Fatalf("Save(unset): %v", err)
	}
	raw, _ = os.ReadFile(path)
	if strings.Contains(string(raw), "THREAD_ACTIVE_WINDOW_HOURS") {
		t.Errorf("an unset knob was written to the config file:\n%s", raw)
	}
	env, err := renderTemplate("chalk.env", InitParams{Domain: "x", ThreadActiveWindowHours: 0})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if strings.Contains(string(env), "CHALK_THREAD_ACTIVE_WINDOW_HOURS") {
		t.Errorf("an unset knob leaked into the env file")
	}
	env, err = renderTemplate("chalk.env", InitParams{Domain: "x", ThreadActiveWindowHours: 72})
	if err != nil {
		t.Fatalf("render(72): %v", err)
	}
	if !strings.Contains(string(env), "CHALK_THREAD_ACTIVE_WINDOW_HOURS=72") {
		t.Errorf("a set knob is missing from the env file")
	}
}

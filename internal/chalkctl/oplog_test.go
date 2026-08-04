package chalkctl

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 85-1: `chalkctl update` surfaces the operational-logging knobs in an env
// file written before phase 85, pinning the snapshot off.
func TestEnsurePhase85Env(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chalk.env")
	if err := os.WriteFile(path, []byte("CHALK_LISTEN=:8443\n"), 0o600); err != nil {
		t.Fatalf("write env: %v", err)
	}

	var log bytes.Buffer
	if err := ensurePhase85Env(path, &log); err != nil {
		t.Fatalf("ensurePhase85Env: %v", err)
	}
	env := readEnvOrFail(t, path)
	want := map[string]string{
		"CHALK_OPLOG_SECURITY":          "true",
		"CHALK_OPLOG_SNAPSHOT_INTERVAL": "0",
		"CHALK_OPLOG_SLOW_REQUEST":      "2s",
	}
	for k, v := range want {
		if env[k] != v {
			t.Errorf("%s = %q, want %q", k, env[k], v)
		}
	}
}

// The backfill runs on every update. Writing an empty value for the snapshot
// would read as "absent" on the next pass and append a duplicate line each
// time, which is why it is pinned to an explicit 0.
func TestEnsurePhase85EnvIsIdempotent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chalk.env")
	if err := os.WriteFile(path, []byte("CHALK_LISTEN=:8443\n"), 0o600); err != nil {
		t.Fatalf("write env: %v", err)
	}
	var log bytes.Buffer
	for i := 0; i < 3; i++ {
		if err := ensurePhase85Env(path, &log); err != nil {
			t.Fatalf("ensurePhase85Env pass %d: %v", i, err)
		}
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read env: %v", err)
	}
	for _, key := range []string{
		"CHALK_OPLOG_SECURITY=",
		"CHALK_OPLOG_SNAPSHOT_INTERVAL=",
		"CHALK_OPLOG_SLOW_REQUEST=",
	} {
		if n := strings.Count(string(body), key); n != 1 {
			t.Errorf("%s appears %d times after three updates, want 1", key, n)
		}
	}
}

// An operator who turned the snapshot on keeps it on across updates.
func TestEnsurePhase85EnvPreservesOperatorChoice(t *testing.T) {
	path := filepath.Join(t.TempDir(), "chalk.env")
	seed := "CHALK_OPLOG_SNAPSHOT_INTERVAL=5m\nCHALK_OPLOG_SECURITY=false\n"
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatalf("write env: %v", err)
	}
	var log bytes.Buffer
	if err := ensurePhase85Env(path, &log); err != nil {
		t.Fatalf("ensurePhase85Env: %v", err)
	}
	env := readEnvOrFail(t, path)
	if env["CHALK_OPLOG_SNAPSHOT_INTERVAL"] != "5m" {
		t.Errorf("backfill overwrote an enabled snapshot: %q", env["CHALK_OPLOG_SNAPSHOT_INTERVAL"])
	}
	if env["CHALK_OPLOG_SECURITY"] != "false" {
		t.Errorf("backfill overwrote a disabled security log: %q", env["CHALK_OPLOG_SECURITY"])
	}
}

// The generated env file carries the knobs on a fresh init too, not just on
// the upgrade path.
func TestInitEnvCarriesOplog(t *testing.T) {
	raw, err := renderTemplate("chalk.env", InitParams{
		Domain: "x.example.org", PGPassword: "PG",
		AdminUsername: "a", AdminEmail: "a@x.org",
	})
	if err != nil {
		t.Fatalf("render chalk.env: %v", err)
	}
	env := string(raw)
	for _, key := range []string{
		"CHALK_OPLOG_SECURITY=true",
		"CHALK_OPLOG_SNAPSHOT_INTERVAL=0",
		"CHALK_OPLOG_SLOW_REQUEST=2s",
	} {
		if !strings.Contains(env, key) {
			t.Errorf("generated env is missing %q", key)
		}
	}
}

package chalkctl

// 80-11: the ephemeral subcommands' plumbing, with podman stubbed by a shell
// script -- what lands in the env/config files and what refuses without
// confirmation is the subject; the SQL runs against real Postgres via the
// store tests it delegates to (the purge itself is chalkd's janitor).

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// stubPodman writes an executable that answers the list query with fixture
// JSON (psqlJSON output) and exits 0 for everything else (the purge SQL).
func stubPodman(t *testing.T, listJSON string) *Podman {
	t.Helper()
	dir := t.TempDir()
	script := filepath.Join(dir, "podman")
	body := `#!/bin/sh
case "$*" in
  *json_agg*) printf '%s' '` + listJSON + `' ;;
  *) cat >/dev/null 2>&1 || true ;;
esac
exit 0
`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return &Podman{Bin: script}
}

const oneRoomJSON = `[{"id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","name":"quick call","created_at":"2026-08-03T10:00:00Z","expires_at":"2026-08-03T20:00:00Z","guests":2,"live_invites":1,"invites":3,"in_call":2,"messages":14}]`

func TestEphemeralPurgeRefusesUnconfirmed(t *testing.T) {
	var out bytes.Buffer
	err := EphemeralPurge(EphemeralOptions{
		Cfg:     Config{Domain: "chat.example.org"},
		Podman:  stubPodman(t, oneRoomJSON),
		Out:     &out,
		Confirm: func(string) bool { return false },
		Restart: func() error { return nil },
	}, "")
	if err == nil || !strings.Contains(err.Error(), "not confirmed") {
		t.Fatalf("unconfirmed purge must abort, got %v", err)
	}
	if !strings.Contains(out.String(), "2 guest account(s)") {
		t.Errorf("pre-report missing: %s", out.String())
	}
}

func TestEphemeralPurgeRejectsBadChannel(t *testing.T) {
	err := EphemeralPurge(EphemeralOptions{
		Podman:  stubPodman(t, "[]"),
		Out:     &bytes.Buffer{},
		Confirm: func(string) bool { return true },
		Restart: func() error { return nil },
	}, "not-a-uuid")
	if err == nil || !strings.Contains(err.Error(), "not a UUID") {
		t.Fatalf("bad channel id must refuse before touching the db, got %v", err)
	}
}

func TestEphemeralPurgeConfirmedRuns(t *testing.T) {
	var out bytes.Buffer
	err := EphemeralPurge(EphemeralOptions{
		Cfg:     Config{Domain: "chat.example.org"},
		Podman:  stubPodman(t, oneRoomJSON),
		Out:     &out,
		Confirm: func(string) bool { return true },
		Restart: func() error { return nil },
	}, "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
	if err != nil {
		t.Fatalf("confirmed purge: %v", err)
	}
	if !strings.Contains(out.String(), "janitor hard-deletes") {
		t.Errorf("output should point at the janitor: %s", out.String())
	}
}

func TestEphemeralDisableWritesBothFiles(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, "chalk.env")
	confPath := filepath.Join(dir, "chalkctl.conf")
	if err := os.WriteFile(envPath,
		[]byte("CHALK_PG_PASSWORD=x\nCHALK_EPHEMERAL_MAX_GUESTS=3\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(confPath,
		[]byte("DOMAIN=chat.example.org\nEPHEMERAL_ENABLED=true\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	restarted := false
	var out bytes.Buffer
	err := EphemeralDisable(EphemeralOptions{
		Cfg:        Config{Domain: "chat.example.org"},
		Podman:     stubPodman(t, "[]"),
		EnvPath:    envPath,
		ConfigPath: confPath,
		Out:        &out,
		Restart:    func() error { restarted = true; return nil },
	})
	if err != nil {
		t.Fatalf("disable: %v", err)
	}
	env, err := readEnvSecrets(envPath)
	if err != nil {
		t.Fatal(err)
	}
	if env["CHALK_EPHEMERAL_ENABLED"] != "false" {
		t.Errorf("env flag not written: %v", env)
	}
	if env["CHALK_EPHEMERAL_MAX_GUESTS"] != "3" {
		t.Error("unrelated env lines must survive")
	}
	conf, err := readEnvSecrets(confPath)
	if err != nil {
		t.Fatal(err)
	}
	if conf["EPHEMERAL_ENABLED"] != "false" {
		t.Errorf("config flag not written: %v", conf)
	}
	if !restarted {
		t.Error("chalkd must be restarted to load the flag")
	}
}

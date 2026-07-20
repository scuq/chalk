package chalkctl

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadConfigFile_overlayAndDefaults(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "chalkctl.conf")
	os.WriteFile(p, []byte("DOMAIN=chat.example.org\nVOICE_ENABLED=false\nPOSTGRES_TAG=17-alpine\n"), 0o644)

	cfg, err := LoadConfigFile(DefaultConfig(), p)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Domain != "chat.example.org" {
		t.Errorf("domain: got %q", cfg.Domain)
	}
	if cfg.VoiceEnabled {
		t.Error("VOICE_ENABLED=false not applied")
	}
	if cfg.PostgresTag != "17-alpine" {
		t.Errorf("postgres tag: got %q", cfg.PostgresTag)
	}
	// Untouched key keeps the default.
	if cfg.CaddyTag != DefaultCaddyTag {
		t.Errorf("caddy tag should be default, got %q", cfg.CaddyTag)
	}
}

func TestLoadConfigFile_missingIsOK(t *testing.T) {
	cfg, err := LoadConfigFile(DefaultConfig(), "/no/such/file.conf")
	if err != nil {
		t.Fatalf("missing file must not error: %v", err)
	}
	if cfg.Image != DefaultImage {
		t.Error("defaults lost")
	}
}

func TestConfigValidate(t *testing.T) {
	base := DefaultConfig()
	base.Domain = "chat.example.org"
	base.Rootful = true
	if err := base.Validate(); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	// rootless rejected
	rl := base
	rl.Rootful = false
	if err := rl.Validate(); err == nil {
		t.Error("rootless should be rejected")
	}
	// bad domain rejected
	bd := base
	bd.Domain = "https://x:443/y"
	if err := bd.Validate(); err == nil {
		t.Error("domain with scheme/port/path should be rejected")
	}
	// empty domain rejected
	ed := base
	ed.Domain = ""
	if err := ed.Validate(); err == nil {
		t.Error("empty domain should be rejected")
	}
}

func TestSaveRoundTrip(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "c.conf")
	in := DefaultConfig()
	in.Domain = "chat.example.org"
	in.Rootful = true
	in.VoiceEnabled = false
	if err := in.Save(p); err != nil {
		t.Fatal(err)
	}
	out, err := LoadConfigFile(DefaultConfig(), p)
	if err != nil {
		t.Fatal(err)
	}
	if out.Domain != in.Domain || out.Rootful != in.Rootful || out.VoiceEnabled != in.VoiceEnabled {
		t.Errorf("round trip mismatch: %+v vs %+v", in, out)
	}
}

func TestGenSecret(t *testing.T) {
	a, err := genSecret(24)
	if err != nil {
		t.Fatal(err)
	}
	b, _ := genSecret(24)
	if a == b {
		t.Error("secrets should differ")
	}
	if strings.ContainsAny(a, "/+=") {
		t.Errorf("secret has env-unfriendly chars: %q", a)
	}
	if len(a) < 30 {
		t.Errorf("secret too short: %q", a)
	}
}

func TestStateRoundTrip(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "state.json")
	if _, ok, _ := LoadState(p); ok {
		t.Error("missing state should report ok=false")
	}
	in := State{Channel: "stable", CurrentVersion: "v0.1.0", CurrentDigest: "sha256:abc"}
	if err := in.Save(p); err != nil {
		t.Fatal(err)
	}
	got, ok, err := LoadState(p)
	if err != nil || !ok {
		t.Fatalf("load: ok=%v err=%v", ok, err)
	}
	if got.CurrentDigest != "sha256:abc" {
		t.Errorf("digest: got %q", got.CurrentDigest)
	}
	if got.UpdatedAt.IsZero() {
		t.Error("UpdatedAt should be stamped")
	}
}

func TestCosignIdentityRegexp(t *testing.T) {
	v := NewCosignVerifier("scuq/chalk")
	re := v.identityRegexp()
	if !strings.Contains(re, `scuq/chalk`) {
		t.Errorf("regexp missing repo: %s", re)
	}
	if !strings.Contains(re, `release-chalk\.yml`) {
		t.Errorf("regexp should pin the workflow file: %s", re)
	}
	// dots escaped
	if strings.Contains(re, "github.com/") {
		t.Errorf("dots should be escaped: %s", re)
	}
}

// TestRenderAllTemplates renders every embedded template with a full param
// set and checks the key substitutions landed -- catches missingkey errors
// and template typos at test time.
func TestRenderAllTemplates(t *testing.T) {
	p := InitParams{
		Domain: "chat.example.org", Image: "ghcr.io/scuq/chalk",
		Version: "v0.1.0", Digest: "sha256:deadbeef",
		PostgresTag: "18-alpine", CaddyTag: "2-alpine",
		VoiceEnabled: true, PGPassword: "PGSECRET", TurnSecret: "TURNSECRET",
		ChalkctlPath: "/usr/local/bin/chalkctl",
	}
	all := append([]string{}, unitTemplates...)
	all = append(all, "Caddyfile", "chalk.env", "chalk-update.service", "chalk-update.timer")
	for _, name := range all {
		data, err := renderTemplate(name, p)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if len(data) == 0 {
			t.Fatalf("%s rendered empty", name)
		}
	}

	// Targeted content checks.
	chalkd, _ := renderTemplate("chalkd.container", p)
	if !strings.Contains(string(chalkd), "@sha256:deadbeef") {
		t.Error("chalkd unit not digest-pinned")
	}
	if !strings.Contains(string(chalkd), "turn:chat.example.org:3478") {
		t.Error("voice-on chalkd should have TURN URL")
	}
	env, _ := renderTemplate("chalk.env", p)
	if !strings.Contains(string(env), "CHALK_PG_PASSWORD=PGSECRET") ||
		!strings.Contains(string(env), "CHALK_TURN_SECRET=TURNSECRET") {
		t.Error("env file missing secrets")
	}
	// DB URL must be a LITERAL in the env file (password inlined), never a
	// ${...} cross-reference -- systemd expands Environment= before
	// EnvironmentFile= loads, so cross-refs collapse to empty.
	if !strings.Contains(string(env), "CHALK_DB_URL=postgres://chalk:PGSECRET@postgres:5432/chalk") {
		t.Error("env file must carry a literal CHALK_DB_URL with the password inlined")
	}
	if strings.Contains(string(chalkd), "${CHALK_PG_PASSWORD}") ||
		strings.Contains(string(chalkd), "${CHALK_TURN_SECRET}") {
		t.Error("chalkd unit must not cross-reference env vars (they expand empty)")
	}
	caddy, _ := renderTemplate("Caddyfile", p)
	if !strings.Contains(string(caddy), "chat.example.org {") {
		t.Error("Caddyfile missing domain block")
	}
	timer, _ := renderTemplate("chalk-update.service", p)
	if !strings.Contains(string(timer), "/usr/local/bin/chalkctl update") {
		t.Error("update service missing chalkctl path")
	}
}

func TestRenderVoiceOff(t *testing.T) {
	p := InitParams{
		Domain: "x.example.org", Image: "ghcr.io/scuq/chalk", Version: "v0.1.0",
		Digest: "sha256:ab", PostgresTag: "18-alpine", CaddyTag: "2-alpine",
		VoiceEnabled: false, PGPassword: "PG", ChalkctlPath: "/usr/local/bin/chalkctl",
	}
	chalkd, _ := renderTemplate("chalkd.container", p)
	if strings.Contains(string(chalkd), "CHALK_TURN_URLS") {
		t.Error("voice-off chalkd should NOT set TURN URL")
	}
	if !strings.Contains(string(chalkd), "CHALK_VOICE_ENABLED=false") {
		t.Error("voice-off flag missing")
	}
	env, _ := renderTemplate("chalk.env", p)
	if strings.Contains(string(env), "CHALK_TURN_SECRET") {
		t.Error("voice-off env should not carry TURN secret")
	}
}

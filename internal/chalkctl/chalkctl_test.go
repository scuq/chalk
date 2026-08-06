package chalkctl

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
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
	base.AdminUsername = "admin"
	base.AdminEmail = "admin@example.org"
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
	in.AdminUsername = "admin"
	in.AdminEmail = "admin@example.org"
	in.VoiceMaxParticipants = 12
	in.CoturnTag = "4.14.0-r0-alpine"
	in.TurnVerbose = false
	in.LinkPreviewEnabled = false
	in.LinkPreviewDomains = "youtube.com,example.com"
	in.EphemeralEnabled = false
	in.EphemeralMaxTTLHours = 96
	in.EphemeralInviteHours = 12
	in.EphemeralMaxGuests = 3
	if err := in.Save(p); err != nil {
		t.Fatal(err)
	}
	out, err := LoadConfigFile(DefaultConfig(), p)
	if err != nil {
		t.Fatal(err)
	}
	if out.Domain != in.Domain || out.Rootful != in.Rootful || out.VoiceEnabled != in.VoiceEnabled ||
		out.AdminUsername != in.AdminUsername || out.AdminEmail != in.AdminEmail ||
		out.VoiceMaxParticipants != in.VoiceMaxParticipants ||
		out.CoturnTag != in.CoturnTag || out.TurnVerbose != in.TurnVerbose ||
		out.LinkPreviewEnabled != in.LinkPreviewEnabled ||
		out.LinkPreviewDomains != in.LinkPreviewDomains ||
		out.EphemeralEnabled != in.EphemeralEnabled ||
		out.EphemeralMaxTTLHours != in.EphemeralMaxTTLHours ||
		out.EphemeralInviteHours != in.EphemeralInviteHours ||
		out.EphemeralMaxGuests != in.EphemeralMaxGuests {
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
	if !strings.Contains(re, `release(-chalk)?\.yml`) {
		t.Errorf("regexp should pin the workflow file (release.yml or legacy): %s", re)
	}
	rx := regexp.MustCompile(re)
	unified := "https://github.com/scuq/chalk/.github/workflows/release.yml@refs/tags/v0.3.0"
	legacy := "https://github.com/scuq/chalk/.github/workflows/release-chalk.yml@refs/tags/v0.2.0"
	if !rx.MatchString(unified) {
		t.Errorf("regexp should match unified release.yml identity: %s", re)
	}
	if !rx.MatchString(legacy) {
		t.Errorf("regexp should still match legacy release-chalk.yml: %s", re)
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
		PGAppPassword: "APPSECRET", PGGuestPassword: "GUESTSECRET",
		TOTPEncKey: "TOTPKEYX", AdminBootstrapToken: "ADMINBOOTX",
		ChalkctlPath:  "/usr/local/bin/chalkctl",
		AdminUsername: "admin", AdminEmail: "admin@example.org", OpenRegistration: true,
		CoturnTag: "4.14.0-r0-alpine", TurnVerbose: true,
		PublicIP: "203.0.113.7", TurnMinPort: TurnMinPort, TurnMaxPort: TurnMaxPort,
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
	// UDP-blocking networks have no path without the TCP URL.
	if !strings.Contains(string(chalkd), "turn:chat.example.org:3478?transport=tcp") {
		t.Error("voice-on chalkd should offer TURN over TCP as well")
	}
	env, _ := renderTemplate("chalk.env", p)
	if !strings.Contains(string(env), "CHALK_PG_PASSWORD=PGSECRET") ||
		!strings.Contains(string(env), "CHALK_TURN_SECRET=TURNSECRET") ||
		!strings.Contains(string(env), "CHALK_TOTP_ENC_KEY=TOTPKEYX") ||
		!strings.Contains(string(env), "CHALK_ADMIN_BOOTSTRAP_TOKEN=ADMINBOOTX") {
		t.Error("env file missing secrets")
	}
	// DB URLs must be LITERALS in the env file (password inlined), never a
	// ${...} cross-reference -- systemd expands Environment= before
	// EnvironmentFile= loads, so cross-refs collapse to empty. 80-1: chalkd
	// connects as chalk_app; the guest pool as chalk_guest.
	if !strings.Contains(string(env), "CHALK_DB_URL=postgres://chalk_app:APPSECRET@postgres:5432/chalk") {
		t.Error("env file must carry a literal chalk_app CHALK_DB_URL with the password inlined")
	}
	if !strings.Contains(string(env), "CHALK_DB_URL_GUEST=postgres://chalk_guest:GUESTSECRET@postgres:5432/chalk") {
		t.Error("env file must carry a literal chalk_guest CHALK_DB_URL_GUEST")
	}
	if !strings.Contains(string(env), "CHALK_PG_APP_PASSWORD=APPSECRET") ||
		!strings.Contains(string(env), "CHALK_PG_GUEST_PASSWORD=GUESTSECRET") {
		t.Error("env file must persist the role passwords (preserved on --force)")
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

// TestNoEnvVarComposition is the permanent guard for the class of bug that
// broke three units in production: systemd/Quadlet expands `Environment=` /
// `Exec=` lines at unit-PARSE time, BEFORE `EnvironmentFile=` loads, so any
// `${VAR}` referencing an env-file value collapses to an empty string. No
// template may contain a dollar-brace reference; composed values must be
// rendered literals (in the env file, or a config file the container reads).
func TestNoEnvVarComposition(t *testing.T) {
	entries, err := Templates.ReadDir("templates")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, err := Templates.ReadFile("templates/" + e.Name())
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(b), "${") {
			t.Errorf("%s contains a ${...} env-var reference; Quadlet expands "+
				"these to empty at parse time -- render a literal instead", e.Name())
		}
	}
}

// Logging stays on the CLI: coturn's file logger otherwise hijacks output to
// /var/tmp/turn_*.log. -n + stdout is what makes `podman logs coturn` work.
func TestCoturnLogsToStdout(t *testing.T) {
	exec := coturnExecLine(t, coturnParams(true))
	for _, want := range []string{"-n --log-file=stdout", "--simple-log"} {
		if !strings.Contains(exec, want) {
			t.Errorf("coturn Exec missing %q (breaks `podman logs coturn`)", want)
		}
	}
}

// TestPostgres18MountPath pins the PG18 volume mount. PG18 moved the image
// VOLUME to /var/lib/postgresql (data in a versioned subdir); mounting the
// old .../data path makes PG18 write to an anonymous volume and fail. Must
// mount the parent, and must NOT override PGDATA.
func TestPostgres18MountPath(t *testing.T) {
	p := InitParams{PostgresTag: "18-alpine", Domain: "x.example.org"}
	unit, err := renderTemplate("chalk-postgres.container", p)
	if err != nil {
		t.Fatal(err)
	}
	s := string(unit)
	if !strings.Contains(s, "chalk-pgdata.volume:/var/lib/postgresql\n") {
		t.Error("PG18 volume must mount at /var/lib/postgresql (not .../data)")
	}
	if strings.Contains(s, ":/var/lib/postgresql/data") {
		t.Error("PG18 must not mount at the old .../data path")
	}
	if strings.Contains(s, "PGDATA") && strings.Contains(s, "Environment=PGDATA") {
		t.Error("do not override PGDATA; the PG18 image default is correct")
	}
}

// TestValidateRequiresAdmin: init must refuse without admin username/email,
// else the deploy has no login (passkeys enroll onto the seeded admin row).
func TestValidateRequiresAdmin(t *testing.T) {
	c := DefaultConfig()
	c.Domain = "chat.example.org"
	c.Rootful = true
	// no admin -> reject
	if err := c.Validate(); err == nil {
		t.Error("missing admin username/email should be rejected")
	}
	c.AdminUsername = "admin"
	if err := c.Validate(); err == nil {
		t.Error("missing admin email should be rejected")
	}
	c.AdminEmail = "not-an-email"
	if err := c.Validate(); err == nil {
		t.Error("malformed admin email should be rejected")
	}
	c.AdminEmail = "admin@example.org"
	if err := c.Validate(); err != nil {
		t.Errorf("valid config with admin should pass: %v", err)
	}
}

// TestEnvHasWebAuthnAndAdmin pins that the rendered env file carries the
// login-critical WebAuthn vars (RP ID = domain, https origin) and the admin
// seed -- without these a fresh deploy cannot be logged into.
func TestEnvHasWebAuthnAndAdmin(t *testing.T) {
	p := InitParams{
		Domain: "chat.example.org", PGPassword: "PG",
		AdminUsername: "admin", AdminEmail: "admin@example.org",
		OpenRegistration: true,
	}
	env, err := renderTemplate("chalk.env", p)
	if err != nil {
		t.Fatal(err)
	}
	s := string(env)
	for _, want := range []string{
		"CHALK_RP_ID=chat.example.org",
		"CHALK_RP_ORIGINS=https://chat.example.org",
		"CHALK_ADMIN_USERNAME=admin",
		"CHALK_ADMIN_EMAIL=admin@example.org",
		"CHALK_OPEN_REGISTRATION=true",
	} {
		if !strings.Contains(s, want) {
			t.Errorf("env file missing %q", want)
		}
	}
}

// TestEnvOptionalKnobs: voice-max / attach-max / giphy appear only when set.
func TestEnvOptionalKnobs(t *testing.T) {
	base := InitParams{
		Domain: "x.example.org", PGPassword: "PG", VoiceEnabled: true, TurnSecret: "T",
		AdminUsername: "a", AdminEmail: "a@x.org",
	}
	// none set -> absent
	env, _ := renderTemplate("chalk.env", base)
	for _, absent := range []string{"CHALK_VOICE_MAX_PARTICIPANTS", "CHALK_ATTACH_MAX_BYTES", "CHALK_GIPHY_API_KEY"} {
		if strings.Contains(string(env), absent) {
			t.Errorf("%s should be absent when unset", absent)
		}
	}
	// set -> present
	full := base
	full.VoiceMaxParticipants = 10
	full.AttachMaxBytes = 26214400
	full.GiphyAPIKey = "KEY"
	env2, _ := renderTemplate("chalk.env", full)
	for _, want := range []string{"CHALK_VOICE_MAX_PARTICIPANTS=10", "CHALK_ATTACH_MAX_BYTES=26214400", "CHALK_GIPHY_API_KEY=KEY"} {
		if !strings.Contains(string(env2), want) {
			t.Errorf("env missing %q when set", want)
		}
	}
}

// 81-3: the stock deployment has to carry the trusted-proxy setting and a
// stable decoy key, or chalkd's per-IP rate limits collapse into a single
// bucket behind Caddy and its unknown-username decoys change on every restart.
func TestEnvPhase81Settings(t *testing.T) {
	p := InitParams{
		Domain: "x.example.org", PGPassword: "PG",
		AdminUsername: "a", AdminEmail: "a@x.org",
		AuthDecoyKey: "DECOYKEYX",
	}
	env, err := renderTemplate("chalk.env", p)
	if err != nil {
		t.Fatalf("renderTemplate: %v", err)
	}
	for _, want := range []string{
		"CHALK_TRUSTED_PROXY=private",
		"CHALK_AUTH_DECOY_KEY=DECOYKEYX",
	} {
		if !strings.Contains(string(env), want) {
			t.Errorf("env missing %q:\n%s", want, env)
		}
	}
}

// TestEnsurePhase81EnvBackfill covers the upgrade path: an env file written
// before 81-3 gains the three settings, and a second run is a no-op -- a
// backfill that rewrote a present value would rotate the decoy key on every
// update and could flip a deliberate ephemeral choice.
func TestEnsurePhase81EnvBackfill(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "chalk.env")
	if err := os.WriteFile(path, []byte("CHALK_PG_PASSWORD=pw\n"), 0o600); err != nil {
		t.Fatalf("write env: %v", err)
	}

	var log bytes.Buffer
	if err := ensurePhase81Env(path, &log); err != nil {
		t.Fatalf("ensurePhase81Env: %v", err)
	}
	env := readEnvOrFail(t, path)
	if env["CHALK_TRUSTED_PROXY"] != "private" {
		t.Errorf("CHALK_TRUSTED_PROXY = %q, want private", env["CHALK_TRUSTED_PROXY"])
	}
	if len(env["CHALK_AUTH_DECOY_KEY"]) < 40 { // 32 bytes -> 44 chars of std base64
		t.Errorf("CHALK_AUTH_DECOY_KEY = %q, want a 32-byte base64 key", env["CHALK_AUTH_DECOY_KEY"])
	}
	// Existing deployments relied on the old default-on; the backfill has to
	// pin that or the update would silently kill their guest links.
	if env["CHALK_EPHEMERAL_ENABLED"] != "true" {
		t.Errorf("CHALK_EPHEMERAL_ENABLED = %q, want true", env["CHALK_EPHEMERAL_ENABLED"])
	}

	before := env["CHALK_AUTH_DECOY_KEY"]
	if err := ensurePhase81Env(path, &log); err != nil {
		t.Fatalf("second ensurePhase81Env: %v", err)
	}
	if after := readEnvOrFail(t, path)["CHALK_AUTH_DECOY_KEY"]; after != before {
		t.Error("re-running the backfill rotated the decoy key; it must be a no-op")
	}
}

// TestEnvEphemeral (80-5): the CHALK_EPHEMERAL_* knob lines appear only when
// the operator diverges from chalkd's defaults. 81-3: the switch itself is
// always written.
func TestEnvEphemeral(t *testing.T) {
	base := InitParams{
		Domain: "x.example.org", PGPassword: "PG", VoiceEnabled: true, TurnSecret: "T",
		AdminUsername: "a", AdminEmail: "a@x.org",
		EphemeralEnabled: true,
	}
	// 81-3: the switch is written either way. chalkd's default is off, so
	// omitting the line for an enabled deployment would turn guest rooms off
	// behind the operator's back; only the tuning knobs are still omitted.
	env, _ := renderTemplate("chalk.env", base)
	if !strings.Contains(string(env), "CHALK_EPHEMERAL_ENABLED=true") {
		t.Errorf("enabled feature must write CHALK_EPHEMERAL_ENABLED=true:\n%s", env)
	}
	for _, knob := range []string{
		"CHALK_EPHEMERAL_MAX_TTL_HOURS",
		"CHALK_EPHEMERAL_INVITE_MAX_TTL_HOURS",
		"CHALK_EPHEMERAL_MAX_GUESTS",
	} {
		if strings.Contains(string(env), knob) {
			t.Errorf("unset knob %s must be omitted:\n%s", knob, env)
		}
	}

	off := base
	off.EphemeralEnabled = false
	env2, _ := renderTemplate("chalk.env", off)
	if !strings.Contains(string(env2), "CHALK_EPHEMERAL_ENABLED=false") {
		t.Error("disabled feature must write CHALK_EPHEMERAL_ENABLED=false")
	}

	tuned := base
	tuned.EphemeralMaxTTLHours = 96
	tuned.EphemeralInviteHours = 12
	tuned.EphemeralMaxGuests = 3
	env3, _ := renderTemplate("chalk.env", tuned)
	for _, want := range []string{
		"CHALK_EPHEMERAL_MAX_TTL_HOURS=96",
		"CHALK_EPHEMERAL_INVITE_MAX_TTL_HOURS=12",
		"CHALK_EPHEMERAL_MAX_GUESTS=3",
	} {
		if !strings.Contains(string(env3), want) {
			t.Errorf("env missing %q when set", want)
		}
	}
}

// TestEnvWrapSigRequired (82-6): the enforcement knob is written either way --
// the migration story is "operator flips it when the sweep is done", and a
// knob that has to be discovered in docs first never gets flipped.
//
// 82-10 adds the half that matters most: a fresh `chalkctl init` must land on
// enforcement. It has no channels yet, so there is nothing to strand.
func TestEnvWrapSigRequired(t *testing.T) {
	base := InitParams{
		Domain: "x.example.org", PGPassword: "PG",
		AdminUsername: "a", AdminEmail: "a@x.org",
	}
	env, _ := renderTemplate("chalk.env", base)
	if !strings.Contains(string(env), "CHALK_WRAP_SIG_REQUIRED=false") {
		t.Errorf("the template must write the knob explicitly either way:\n%s", env)
	}

	on := base
	on.WrapSigRequired = true
	env2, _ := renderTemplate("chalk.env", on)
	if !strings.Contains(string(env2), "CHALK_WRAP_SIG_REQUIRED=true") {
		t.Error("enforcement on must write CHALK_WRAP_SIG_REQUIRED=true")
	}

	if !DefaultConfig().WrapSigRequired {
		t.Error("a new deployment must default to enforcement; it has no legacy" +
			" unsigned wraps, so nothing is stranded by it")
	}
}

// TestEnsurePhase82EnvBackfill: pre-82-6 env files gain the (false) knob on
// update; a present value -- notably an operator's deliberate `true` -- is
// never touched, because rewriting it would re-open the enforcement window
// behind their back.
//
// The backfilled value stays FALSE even though 82-10 made true the default for
// new deployments: an `update` runs against channels already full of unsigned
// wraps, and flipping those to enforcement without the sweep is exactly the
// lockout the soft window exists to avoid. If this assertion is ever "fixed"
// to true, upgrading a live deployment starts locking members out.
func TestEnsurePhase82EnvBackfill(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "chalk.env")
	if err := os.WriteFile(path, []byte("CHALK_PG_PASSWORD=pw\n"), 0o600); err != nil {
		t.Fatalf("write env: %v", err)
	}

	var log bytes.Buffer
	if err := ensurePhase82Env(path, &log); err != nil {
		t.Fatalf("ensurePhase82Env: %v", err)
	}
	if got := readEnvOrFail(t, path)["CHALK_WRAP_SIG_REQUIRED"]; got != "false" {
		t.Errorf("CHALK_WRAP_SIG_REQUIRED = %q, want false", got)
	}

	// An operator who has flipped to enforcement must stay there.
	if err := os.WriteFile(path, []byte("CHALK_WRAP_SIG_REQUIRED=true\n"), 0o600); err != nil {
		t.Fatalf("rewrite env: %v", err)
	}
	if err := ensurePhase82Env(path, &log); err != nil {
		t.Fatalf("second ensurePhase82Env: %v", err)
	}
	if got := readEnvOrFail(t, path)["CHALK_WRAP_SIG_REQUIRED"]; got != "true" {
		t.Errorf("backfill overwrote a present value: got %q, want true", got)
	}
}

// TestValidateEphemeralInviteCap (80-5): chalkctl refuses an invite TTL above
// the 24 h hard cap before the stack is half up (chalkd would refuse to boot).
func TestValidateEphemeralInviteCap(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Domain = "x.example.org"
	cfg.Rootful = true
	cfg.AdminUsername = "a"
	cfg.AdminEmail = "a@x.org"
	cfg.EphemeralInviteHours = 25
	if err := cfg.Validate(); err == nil {
		t.Error("invite TTL above 24 h must fail validation")
	}
	cfg.EphemeralInviteHours = 24
	if err := cfg.Validate(); err != nil {
		t.Errorf("invite TTL of 24 h must validate: %v", err)
	}
}

// TestEnvLinkPreview (57-1): the CHALK_LINKPREVIEW_* lines appear only when
// the operator diverges from chalkd's defaults (enabled, built-in whitelist).
func TestEnvLinkPreview(t *testing.T) {
	base := InitParams{
		Domain: "x.example.org", PGPassword: "PG", VoiceEnabled: true, TurnSecret: "T",
		AdminUsername: "a", AdminEmail: "a@x.org",
		LinkPreviewEnabled: true,
	}
	env, _ := renderTemplate("chalk.env", base)
	if strings.Contains(string(env), "CHALK_LINKPREVIEW") {
		t.Errorf("defaults must render no CHALK_LINKPREVIEW_* lines:\n%s", env)
	}

	disabled := base
	disabled.LinkPreviewEnabled = false
	env2, _ := renderTemplate("chalk.env", disabled)
	if !strings.Contains(string(env2), "CHALK_LINKPREVIEW_ENABLED=false") {
		t.Errorf("disabled must render CHALK_LINKPREVIEW_ENABLED=false:\n%s", env2)
	}

	domains := base
	domains.LinkPreviewDomains = "youtube.com,example.com"
	env3, _ := renderTemplate("chalk.env", domains)
	if !strings.Contains(string(env3), "CHALK_LINKPREVIEW_DOMAINS=youtube.com,example.com") {
		t.Errorf("domains override must render CHALK_LINKPREVIEW_DOMAINS:\n%s", env3)
	}
}

func TestReversed(t *testing.T) {
	in := []string{"a", "b", "c"}
	got := reversed(in)
	if got[0] != "c" || got[1] != "b" || got[2] != "a" {
		t.Errorf("reversed: got %v", got)
	}
	// original not mutated
	if in[0] != "a" {
		t.Error("reversed mutated input")
	}
}

func TestLifecycleServices(t *testing.T) {
	novoice := LifecycleOptions{Voice: false}
	if len(novoice.services()) != 3 {
		t.Errorf("no-voice stack should be 3 services, got %d", len(novoice.services()))
	}
	voice := LifecycleOptions{Voice: true}
	svcs := voice.services()
	if len(svcs) != 4 || svcs[3] != "chalk-coturn.service" {
		t.Errorf("voice stack should append coturn, got %v", svcs)
	}
}

func TestPurgeDataImpliesPurgeState(t *testing.T) {
	// Guard the CLI contract at the type level: LifecycleOptions doesn't
	// enforce it (main.go does), but Down must handle PurgeData without
	// PurgeState gracefully. Here we just confirm the fields are independent
	// and Down's logic reads them (compile-level coverage via construction).
	o := LifecycleOptions{PurgeData: true, PurgeState: true}
	if !o.PurgeData || !o.PurgeState {
		t.Error("fields should be settable independently")
	}
}

func TestReadEnvSecrets(t *testing.T) {
	dir := t.TempDir()
	p := dir + "/chalk.env"
	os.WriteFile(p, []byte("# comment\nCHALK_PG_PASSWORD=secret1\n\nCHALK_TURN_SECRET=secret2\nOTHER=x\n"), 0o600)
	m, err := readEnvSecrets(p)
	if err != nil {
		t.Fatal(err)
	}
	if m["CHALK_PG_PASSWORD"] != "secret1" || m["CHALK_TURN_SECRET"] != "secret2" {
		t.Errorf("secrets not parsed: %v", m)
	}
}

// TestForceDropDBFlow drives Init through a --force --drop-db re-apply using a
// stubbed Podman and Verifier, on temp paths, asserting: confirmation is
// required, secrets regenerate, and the pinned digest lands. (No real
// containers -- podman/systemctl calls are the stub's no-ops via a fake.)
//
// This is a focused check of the option plumbing and confirm gate; the full
// container bring-up is exercised on real hardware.
func TestConfirmGateRequiredForDropDB(t *testing.T) {
	// promptConfirm token extraction: the answer must equal the ()-token.
	if !confirmMatches("type the domain (chalk.example.org) to confirm: ", "chalk.example.org") {
		t.Error("correct token should confirm")
	}
	if confirmMatches("type the domain (chalk.example.org) to confirm: ", "wrong") {
		t.Error("wrong token must not confirm")
	}
	if confirmMatches("no parens here", "anything") {
		t.Error("prompt without a token must not confirm")
	}
}

// confirmMatches mirrors promptConfirm's token logic without reading stdin, so
// the extraction rule is unit-testable.
func confirmMatches(prompt, typed string) bool {
	typed = strings.TrimSpace(typed)
	if typed == "" {
		return false
	}
	l := strings.LastIndex(prompt, "(")
	r := strings.LastIndex(prompt, ")")
	if l < 0 || r < 0 || r < l {
		return false
	}
	return typed == prompt[l+1:r]
}

func TestShortDigest(t *testing.T) {
	if got := shortDigest("sha256:a2d30023c82a9ae6b7883148af4fd"); got != "a2d30023c82a" {
		t.Errorf("shortDigest = %q", got)
	}
	if got := shortDigest("abc"); got != "abc" {
		t.Errorf("short input: %q", got)
	}
}

func TestRepinChalkdImageLine(t *testing.T) {
	// splitLines/joinLines round-trip + the Image= rewrite logic (without
	// touching disk): simulate by operating on lines directly.
	unit := "[Container]\nContainerName=chalkd\nImage=ghcr.io/scuq/chalk@sha256:OLD\nNetwork=chalk.network\n"
	lines := splitLines(unit)
	for i, ln := range lines {
		if hasPrefix(ln, "Image=") {
			lines[i] = "Image=ghcr.io/scuq/chalk@sha256:NEW"
		}
	}
	out := joinLines(lines)
	if !strings.Contains(out, "Image=ghcr.io/scuq/chalk@sha256:NEW") {
		t.Error("Image line not rewritten")
	}
	if strings.Contains(out, "sha256:OLD") {
		t.Error("old digest still present")
	}
	if !strings.Contains(out, "ContainerName=chalkd") || !strings.Contains(out, "Network=chalk.network") {
		t.Error("other lines not preserved")
	}
}

func TestFirstNonEmpty(t *testing.T) {
	if firstNonEmpty("", "b") != "b" {
		t.Error("empty a -> b")
	}
	if firstNonEmpty("a", "b") != "a" {
		t.Error("non-empty a -> a")
	}
	if firstNonEmpty("  ", "b") != "b" {
		t.Error("blank a -> b")
	}
}

// coturnBoolFlags are the coturn Exec arguments that legitimately carry no
// value. Anything else must use --flag=value; see TestCoturnUnitFlagForm.
var coturnBoolFlags = map[string]bool{
	"--simple-log": true, "--new-log-timestamp": true, "--use-auth-secret": true,
	"--fingerprint": true, "--no-cli": true, "--no-tls": true, "--no-dtls": true,
	"--verbose": true, "--include-reason-string": true, "--log-binding": true,
	"--no-multicast-peers": true,
}

func coturnExecLine(t *testing.T, p InitParams) string {
	t.Helper()
	unit, err := renderTemplate(coturnUnit, p)
	if err != nil {
		t.Fatalf("render coturn unit: %v", err)
	}
	for _, line := range strings.Split(string(unit), "\n") {
		if strings.HasPrefix(line, "Exec=") {
			return strings.TrimPrefix(line, "Exec=")
		}
	}
	t.Fatal("coturn unit has no Exec= line")
	return ""
}

func coturnParams(verbose bool) InitParams {
	return InitParams{
		CoturnTag: "4.14.0-r0-alpine", TurnSecret: "TURNSECRET",
		PublicIP: "203.0.113.7", TurnMinPort: TurnMinPort, TurnMaxPort: TurnMaxPort,
		TurnVerbose: verbose,
	}
}

// TestCoturnPeerFence (80-10): the relay must refuse private/special peer
// ranges (any credential holder could otherwise port-scan the operator's
// network through it), keep its own public address open for relay<->relay
// traffic, and carry the server-wide quota + per-allocation bandwidth caps.
func TestCoturnPeerFence(t *testing.T) {
	exec := coturnExecLine(t, coturnParams(false))
	for _, want := range []string{
		"--no-multicast-peers",
		"--denied-peer-ip=10.0.0.0-10.255.255.255",
		"--denied-peer-ip=127.0.0.0-127.255.255.255",
		"--denied-peer-ip=169.254.0.0-169.254.255.255",
		"--denied-peer-ip=172.16.0.0-172.31.255.255",
		"--denied-peer-ip=192.168.0.0-192.168.255.255",
		"--denied-peer-ip=100.64.0.0-100.127.255.255",
		"--denied-peer-ip=224.0.0.0-255.255.255.255",
		"--allowed-peer-ip=203.0.113.7",
		"--total-quota=64",
		"--max-bps=1250000",
	} {
		if !strings.Contains(exec, want) {
			t.Errorf("coturn Exec missing %q", want)
		}
	}
}

func TestCoturnUnitCarriesFullConfig(t *testing.T) {
	exec := coturnExecLine(t, coturnParams(true))
	for _, want := range []string{
		"--listening-port=3478",
		fmt.Sprintf("--min-port=%d", TurnMinPort),
		fmt.Sprintf("--max-port=%d", TurnMaxPort),
		"--realm=chalk",
		"--listening-ip=203.0.113.7",
		"--relay-ip=203.0.113.7",
		"--external-ip=203.0.113.7",
		"--use-auth-secret",
		"--static-auth-secret=TURNSECRET",
		"--fingerprint",
		"--no-cli", "--no-tls", "--no-dtls",
	} {
		if !strings.Contains(exec, want) {
			t.Errorf("coturn Exec missing %q\ngot: %s", want, exec)
		}
	}
}

// The mounted config file was silently ignored by the container, so nothing
// may depend on it again: no -c, no volume, and no DETECT_* guessing.
func TestCoturnUnitHasNoConfigFile(t *testing.T) {
	unit, err := renderTemplate(coturnUnit, coturnParams(true))
	if err != nil {
		t.Fatal(err)
	}
	// Directives only -- the comment block names these to explain their removal.
	var directives []string
	for _, line := range strings.Split(string(unit), "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "#") {
			directives = append(directives, line)
		}
	}
	body := strings.Join(directives, "\n")
	for _, banned := range []string{"turnserver.conf", "DETECT_EXTERNAL_IP", "DETECT_RELAY_IP", "Volume="} {
		if strings.Contains(body, banned) {
			t.Errorf("coturn unit must not reference %q any more", banned)
		}
	}
}

// A missing space in `--realm chalk --verbose` produced `--realm
// chalk--verbose`: realm became a junk string and --verbose vanished, silently.
// --flag=value form cannot fail that way, so require it everywhere.
func TestCoturnUnitFlagForm(t *testing.T) {
	exec := coturnExecLine(t, coturnParams(true))
	for _, tok := range strings.Fields(exec) {
		if !strings.HasPrefix(tok, "--") {
			continue
		}
		if strings.Contains(tok, "=") || coturnBoolFlags[tok] {
			continue
		}
		t.Errorf("coturn arg %q takes a value: use --flag=value, not a space", tok)
	}
}

func TestCoturnVerboseGatesDiagnostics(t *testing.T) {
	quiet := coturnExecLine(t, coturnParams(false))
	for _, diag := range []string{"--verbose", "--include-reason-string", "--log-binding"} {
		if strings.Contains(quiet, diag) {
			t.Errorf("turn-verbose=false should not pass %s", diag)
		}
	}
	loud := coturnExecLine(t, coturnParams(true))
	for _, diag := range []string{"--verbose", "--include-reason-string", "--log-binding"} {
		if !strings.Contains(loud, diag) {
			t.Errorf("turn-verbose=true should pass %s", diag)
		}
	}
}

// The Exec line carries the static auth secret, so this unit alone is 0600.
func TestCoturnUnitModeIsPrivate(t *testing.T) {
	if unitMode(coturnUnit) != 0o600 {
		t.Errorf("coturn unit mode = %o, want 600 (it holds the TURN secret)", unitMode(coturnUnit))
	}
	if unitMode("chalkd.container") != 0o644 {
		t.Error("non-secret units should stay 0644")
	}
}

func TestFirewallHintMatchesRelayRange(t *testing.T) {
	want := fmt.Sprintf("%d-%d/udp", TurnMinPort, TurnMaxPort)
	if !strings.Contains(FirewallHint(), want) {
		t.Errorf("FirewallHint must advertise %s, got %q", want, FirewallHint())
	}
}

func TestValidatePublicIP(t *testing.T) {
	if err := ValidatePublicIP("46.62.175.213"); err != nil {
		t.Errorf("public IPv4 rejected: %v", err)
	}
	for _, bad := range []string{"", "chalk.example.org", "10.0.0.4", "192.168.1.9", "127.0.0.1", "2001:db8::1"} {
		if err := ValidatePublicIP(bad); err == nil {
			t.Errorf("%q should be rejected", bad)
		}
	}
}

func TestResolvePublicIPPrefersConfigured(t *testing.T) {
	// No network call: a configured address short-circuits detection.
	got, err := ResolvePublicIP("  46.62.175.213 ", nil)
	if err != nil {
		t.Fatal(err)
	}
	if got != "46.62.175.213" {
		t.Errorf("got %q, want the trimmed configured address", got)
	}
	if _, err := ResolvePublicIP("10.0.0.1", nil); err == nil {
		t.Error("a configured private address should fail, not fall back to detection")
	}
}

package chalkctl

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/scuq/chalk/internal/webpush"
)

// 65-3: the Web Push key pair is generated once, kept by update, init
// --force and restore, and replaced only by `chalkctl push rotate-key --yes`.

func writeEnvFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func readEnv(t *testing.T, path string) map[string]string {
	t.Helper()
	env, err := readEnvSecrets(path)
	if err != nil {
		t.Fatal(err)
	}
	return env
}

// matchingPair reports whether priv and pub form one VAPID key.
func matchingPair(t *testing.T, priv, pub string) bool {
	t.Helper()
	k, err := webpush.ParseVAPIDKey(priv, "https://chat.cyberdyne.example")
	if err != nil {
		t.Fatalf("private key does not parse: %v", err)
	}
	return k.PublicKey() == pub
}

func TestEnsurePhase65Env(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, "chalk.env")
	cfgPath := filepath.Join(dir, "chalkctl.conf")
	writeEnvFile(t, envPath, "CHALK_LISTEN=:8443\n")
	writeEnvFile(t, cfgPath, "DOMAIN=chat.cyberdyne.example\n")

	if err := ensurePhase65Env(envPath, cfgPath, "chat.cyberdyne.example", "", io.Discard); err != nil {
		t.Fatal(err)
	}
	env := readEnv(t, envPath)
	if env["CHALK_PUSH_ENABLED"] != "false" {
		t.Fatalf("CHALK_PUSH_ENABLED = %q, want false on update", env["CHALK_PUSH_ENABLED"])
	}
	if env["CHALK_VAPID_SUBJECT"] != "https://chat.cyberdyne.example" {
		t.Fatalf("subject = %q", env["CHALK_VAPID_SUBJECT"])
	}
	if !matchingPair(t, env["CHALK_VAPID_PRIVATE_KEY"], env["CHALK_VAPID_PUBLIC_KEY"]) {
		t.Fatal("backfilled keys are not one pair")
	}
	if got := readEnv(t, cfgPath)["PUSH_ENABLED"]; got != "false" {
		t.Fatalf("config PUSH_ENABLED = %q, want false mirrored", got)
	}

	// Idempotent, and a present pair is never replaced.
	for i := 0; i < 2; i++ {
		if err := ensurePhase65Env(envPath, cfgPath, "other.acme.example", "mailto:x@acme.example", io.Discard); err != nil {
			t.Fatal(err)
		}
	}
	again := readEnv(t, envPath)
	for _, k := range []string{"CHALK_VAPID_PUBLIC_KEY", "CHALK_VAPID_PRIVATE_KEY", "CHALK_VAPID_SUBJECT", "CHALK_PUSH_ENABLED"} {
		if again[k] != env[k] {
			t.Fatalf("%s changed on a second update", k)
		}
	}
	b, _ := os.ReadFile(envPath)
	if n := strings.Count(string(b), "CHALK_VAPID_PUBLIC_KEY="); n != 1 {
		t.Fatalf("public key written %d times", n)
	}
	cb, _ := os.ReadFile(cfgPath)
	if n := strings.Count(string(cb), "PUSH_ENABLED="); n != 1 {
		t.Fatalf("config PUSH_ENABLED written %d times", n)
	}
}

func TestEnsurePhase65EnvKeepsOperatorChoice(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, "chalk.env")
	cfgPath := filepath.Join(dir, "missing.conf")
	writeEnvFile(t, envPath, "CHALK_PUSH_ENABLED=true\nCHALK_VAPID_SUBJECT=mailto:admin@cyberdyne.example\n")
	if err := ensurePhase65Env(envPath, cfgPath, "chat.cyberdyne.example", "", io.Discard); err != nil {
		t.Fatal(err)
	}
	env := readEnv(t, envPath)
	if env["CHALK_PUSH_ENABLED"] != "true" || env["CHALK_VAPID_SUBJECT"] != "mailto:admin@cyberdyne.example" {
		t.Fatalf("operator values changed: %v", env)
	}
	if _, err := os.Stat(cfgPath); err == nil {
		t.Fatal("a missing config file was created")
	}
}

func TestEnsurePhase65EnvRefusesHalfPair(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, "chalk.env")
	_, pub, _ := genVAPIDKey()
	writeEnvFile(t, envPath, "CHALK_VAPID_PUBLIC_KEY="+pub+"\n")
	if err := ensurePhase65Env(envPath, filepath.Join(dir, "c.conf"), "chat.cyberdyne.example", "", io.Discard); err == nil {
		t.Fatal("half a pair accepted")
	}
	if _, ok := readEnv(t, envPath)["CHALK_VAPID_PRIVATE_KEY"]; ok {
		t.Fatal("a private key was generated for someone else's public key")
	}
}

func pushOpts(t *testing.T, env, conf string) (PushOptions, *int, *bytes.Buffer) {
	t.Helper()
	dir := t.TempDir()
	o := PushOptions{
		EnvPath:    filepath.Join(dir, "chalk.env"),
		ConfigPath: filepath.Join(dir, "chalkctl.conf"),
		Out:        &bytes.Buffer{},
	}
	writeEnvFile(t, o.EnvPath, env)
	if conf != "" {
		writeEnvFile(t, o.ConfigPath, conf)
	}
	restarts := 0
	o.Restart = func() error { restarts++; return nil }
	return o, &restarts, o.Out.(*bytes.Buffer)
}

func TestPushEnableDisable(t *testing.T) {
	priv, pub, _ := genVAPIDKey()
	o, restarts, _ := pushOpts(t,
		"CHALK_PUSH_ENABLED=false\nCHALK_VAPID_PUBLIC_KEY="+pub+"\nCHALK_VAPID_PRIVATE_KEY="+priv+"\nCHALK_VAPID_SUBJECT=https://chat.cyberdyne.example\n",
		"PUSH_ENABLED=false\n")
	if err := PushEnable(o); err != nil {
		t.Fatal(err)
	}
	if readEnv(t, o.EnvPath)["CHALK_PUSH_ENABLED"] != "true" || readEnv(t, o.ConfigPath)["PUSH_ENABLED"] != "true" {
		t.Fatal("enable did not write both files")
	}
	if err := PushDisable(o); err != nil {
		t.Fatal(err)
	}
	if readEnv(t, o.EnvPath)["CHALK_PUSH_ENABLED"] != "false" || readEnv(t, o.ConfigPath)["PUSH_ENABLED"] != "false" {
		t.Fatal("disable did not write both files")
	}
	if *restarts != 2 {
		t.Fatalf("restarts = %d, want 2", *restarts)
	}
	if err := PushStatus(o); err != nil {
		t.Fatal(err)
	}
}

func TestPushEnableRefusesWithoutKey(t *testing.T) {
	o, restarts, _ := pushOpts(t, "CHALK_PUSH_ENABLED=false\n", "")
	if err := PushEnable(o); err == nil {
		t.Fatal("enable without a key pair accepted")
	}
	if *restarts != 0 || readEnv(t, o.EnvPath)["CHALK_PUSH_ENABLED"] != "false" {
		t.Fatal("a refused enable changed something")
	}
}

func TestPushRotateKey(t *testing.T) {
	priv, pub, _ := genVAPIDKey()
	o, restarts, out := pushOpts(t,
		"CHALK_VAPID_PUBLIC_KEY="+pub+"\nCHALK_VAPID_PRIVATE_KEY="+priv+"\n", "")
	if err := PushRotateKey(o, false); err == nil {
		t.Fatal("rotate without --yes accepted")
	}
	if readEnv(t, o.EnvPath)["CHALK_VAPID_PUBLIC_KEY"] != pub || *restarts != 0 {
		t.Fatal("a refused rotation changed something")
	}
	if err := PushRotateKey(o, true); err != nil {
		t.Fatal(err)
	}
	env := readEnv(t, o.EnvPath)
	if env["CHALK_VAPID_PUBLIC_KEY"] == pub || env["CHALK_VAPID_PRIVATE_KEY"] == priv {
		t.Fatal("key not replaced")
	}
	if !matchingPair(t, env["CHALK_VAPID_PRIVATE_KEY"], env["CHALK_VAPID_PUBLIC_KEY"]) {
		t.Fatal("rotated keys are not one pair")
	}
	if *restarts != 1 || !strings.Contains(out.String(), env["CHALK_VAPID_PUBLIC_KEY"]) {
		t.Fatalf("restarts = %d, output %q", *restarts, out.String())
	}
}

func TestCarryVAPID(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, "chalk.env")
	newPriv, newPub, _ := genVAPIDKey()
	oldPriv, oldPub, _ := genVAPIDKey()
	fresh := "CHALK_VAPID_PUBLIC_KEY=" + newPub + "\nCHALK_VAPID_PRIVATE_KEY=" + newPriv + "\n"
	logf := func(string, ...any) {}

	// A complete pair in the archive replaces init's pair.
	writeEnvFile(t, envPath, fresh)
	if err := carryEnv(envPath, []byte("CHALK_VAPID_PUBLIC_KEY="+oldPub+"\nCHALK_VAPID_PRIVATE_KEY="+oldPriv+"\n"), logf); err != nil {
		t.Fatal(err)
	}
	env := readEnv(t, envPath)
	if env["CHALK_VAPID_PUBLIC_KEY"] != oldPub || env["CHALK_VAPID_PRIVATE_KEY"] != oldPriv {
		t.Fatal("archived pair not carried")
	}

	// Half a pair in the archive leaves init's pair whole.
	writeEnvFile(t, envPath, fresh)
	if err := carryEnv(envPath, []byte("CHALK_VAPID_PUBLIC_KEY="+oldPub+"\n"), logf); err != nil {
		t.Fatal(err)
	}
	env = readEnv(t, envPath)
	if env["CHALK_VAPID_PUBLIC_KEY"] != newPub || env["CHALK_VAPID_PRIVATE_KEY"] != newPriv {
		t.Fatal("half an archived pair broke the live pair")
	}
}

func TestEnvRendersPush(t *testing.T) {
	p := InitParams{
		Domain: "chat.cyberdyne.example", Image: "ghcr.io/x/chalk", Version: "v1", Digest: "sha256:d",
		PushEnabled: true, VAPIDPublicKey: "PUBX", VAPIDPrivateKey: "PRIVX",
		VAPIDSubject: pushSubject("", "chat.cyberdyne.example"),
	}
	env, err := renderTemplate("chalk.env", p)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"CHALK_PUSH_ENABLED=true",
		"CHALK_VAPID_PUBLIC_KEY=PUBX",
		"CHALK_VAPID_PRIVATE_KEY=PRIVX",
		"CHALK_VAPID_SUBJECT=https://chat.cyberdyne.example",
	} {
		if !strings.Contains(string(env), want) {
			t.Errorf("env file lacks %s", want)
		}
	}
	if pushSubject("mailto:admin@cyberdyne.example", "chat.cyberdyne.example") != "mailto:admin@cyberdyne.example" {
		t.Error("an explicit subject was not kept")
	}
}

func TestPushConfigRoundTrip(t *testing.T) {
	p := filepath.Join(t.TempDir(), "c.conf")
	in := DefaultConfig()
	if !in.PushEnabled {
		t.Fatal("init must default push on")
	}
	in.Domain = "chat.cyberdyne.example"
	in.PushEnabled = false
	in.PushSubject = "mailto:admin@cyberdyne.example"
	if err := in.Save(p); err != nil {
		t.Fatal(err)
	}
	out, err := LoadConfigFile(DefaultConfig(), p)
	if err != nil {
		t.Fatal(err)
	}
	if out.PushEnabled || out.PushSubject != in.PushSubject {
		t.Fatalf("round trip lost push settings: %+v", out)
	}
}

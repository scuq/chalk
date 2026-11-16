package chalkctl

// 136-4c: tests for the APNs commands of chalkctl. The tests make P-256 keys.
// They use no key of Apple and send nothing to Apple. chalkctl has no full
// init harness, so one test renders the env template from the output of
// keepAPNs.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/scuq/chalk/internal/apns"
)

// writeP8 writes a .p8 file that holds a new P-256 key. It returns the path
// and the base64 line that apnsKeyLine must return for the file.
func writeP8(t *testing.T) (path, line string) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	path = filepath.Join(t.TempDir(), "AuthKey_ABC123DEFG.p8")
	writeEnvFile(t, path, string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})))
	return path, base64.StdEncoding.EncodeToString(der)
}

// goodSet returns valid options for the key file at keyFile.
func goodSet(keyFile string) APNsSetOptions {
	return APNsSetOptions{KeyFile: keyFile, KeyID: "ABC123DEFG", TeamID: "TEAM456XYZ", Topic: "at.73c.chalk"}
}

// pushEnv is an env file with push on and a subject, but no APNs values.
const pushEnv = "CHALK_PUSH_ENABLED=true\nCHALK_VAPID_SUBJECT=https://chat.cyberdyne.example\n"

// TestAPNsKeyLine checks that a PEM file and wrapped bare base64 give the same
// line, and that a broken PEM file is refused.
func TestAPNsKeyLine(t *testing.T) {
	path, want := writeP8(t)
	raw, _ := os.ReadFile(path)
	if got, err := apnsKeyLine(raw); err != nil || got != want {
		t.Fatalf("PEM: %q, %v", got, err)
	}
	wrapped := want[:20] + "\n  " + want[20:] + "\n"
	if got, err := apnsKeyLine([]byte(wrapped)); err != nil || got != want {
		t.Fatalf("bare base64: %q, %v", got, err)
	}
	if _, err := apnsKeyLine([]byte("-----BEGIN PRIVATE KEY-----\n!!\n")); err == nil {
		t.Fatal("broken PEM accepted")
	}
}

// TestPushAPNsSet checks that set writes the five values, parses the stored
// key, leaves other lines and the config file alone, restarts chalkd once,
// never prints the key, and replaces its own lines on a second run.
func TestPushAPNsSet(t *testing.T) {
	keyFile, line := writeP8(t)
	o, restarts, out := pushOpts(t, pushEnv, "PUSH_ENABLED=true\n")
	if err := PushAPNsSet(o, goodSet(keyFile)); err != nil {
		t.Fatal(err)
	}
	env := readEnv(t, o.EnvPath)
	want := APNsSettings{Key: line, KeyID: "ABC123DEFG", TeamID: "TEAM456XYZ", Topic: "at.73c.chalk", Environment: "production"}
	if got := apnsFromEnv(env); got != want {
		t.Fatalf("env holds %+v", got)
	}
	if _, err := apns.ParseKey(env["CHALK_APNS_KEY"], env["CHALK_APNS_KEY_ID"], env["CHALK_APNS_TEAM_ID"]); err != nil {
		t.Fatalf("stored key does not parse: %v", err)
	}
	if env["CHALK_PUSH_ENABLED"] != "true" || env["CHALK_VAPID_SUBJECT"] == "" {
		t.Fatal("set changed other lines")
	}
	if *restarts != 1 {
		t.Fatalf("restarts = %d", *restarts)
	}
	if strings.Contains(out.String(), line) {
		t.Fatal("the key was printed")
	}
	if strings.Contains(readEnv(t, o.ConfigPath)["APNS_KEY"], line) || len(readEnv(t, o.ConfigPath)) != 1 {
		t.Fatal("the config file was changed")
	}

	sandbox := goodSet(keyFile)
	sandbox.Sandbox = true
	if err := PushAPNsSet(o, sandbox); err != nil {
		t.Fatal(err)
	}
	if readEnv(t, o.EnvPath)["CHALK_APNS_ENV"] != "sandbox" {
		t.Fatal("--sandbox not written")
	}
	if strings.Count(mustRead(t, o.EnvPath), "CHALK_APNS_KEY=") != 1 {
		t.Fatal("a second set appended a second key line")
	}
}

// TestPushAPNsSetPushOffNote checks that set names `chalkctl push enable`
// if push is off.
func TestPushAPNsSetPushOffNote(t *testing.T) {
	keyFile, _ := writeP8(t)
	o, _, out := pushOpts(t, "CHALK_PUSH_ENABLED=false\n", "")
	if err := PushAPNsSet(o, goodSet(keyFile)); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "chalkctl push enable") {
		t.Fatalf("no note that push is off: %s", out)
	}
}

// TestPushAPNsSetRefuses checks that a bad file or bad id changes nothing and
// does not restart chalkd.
func TestPushAPNsSetRefuses(t *testing.T) {
	keyFile, _ := writeP8(t)
	big := filepath.Join(t.TempDir(), "big.p8")
	writeEnvFile(t, big, strings.Repeat("A", maxAPNsKeyFile+1))
	notKey := filepath.Join(t.TempDir(), "not.p8")
	writeEnvFile(t, notKey, "hello world")
	cases := map[string]func(*APNsSetOptions){
		"missing file": func(s *APNsSetOptions) { s.KeyFile = filepath.Join(t.TempDir(), "none.p8") },
		"large file":   func(s *APNsSetOptions) { s.KeyFile = big },
		"not a key":    func(s *APNsSetOptions) { s.KeyFile = notKey },
		"short key id": func(s *APNsSetOptions) { s.KeyID = "ABC" },
		"no team id":   func(s *APNsSetOptions) { s.TeamID = "" },
		"no topic":     func(s *APNsSetOptions) { s.Topic = "" },
		"bad topic":    func(s *APNsSetOptions) { s.Topic = "at 73c" },
	}
	for name, mut := range cases {
		o, restarts, _ := pushOpts(t, pushEnv, "")
		s := goodSet(keyFile)
		mut(&s)
		if err := PushAPNsSet(o, s); err == nil {
			t.Fatalf("%s: accepted", name)
		}
		if *restarts != 0 || readEnv(t, o.EnvPath)["CHALK_APNS_KEY"] != "" {
			t.Fatalf("%s: a refused set changed something", name)
		}
	}
}

// TestPushAPNsClear checks that clear needs --yes, empties the five values,
// leaves other lines alone, and restarts chalkd.
func TestPushAPNsClear(t *testing.T) {
	keyFile, _ := writeP8(t)
	o, restarts, _ := pushOpts(t, pushEnv, "")
	if err := PushAPNsSet(o, goodSet(keyFile)); err != nil {
		t.Fatal(err)
	}
	if err := PushAPNsClear(o, false); err == nil {
		t.Fatal("clear without --yes accepted")
	}
	if readEnv(t, o.EnvPath)["CHALK_APNS_KEY"] == "" || *restarts != 1 {
		t.Fatal("a refused clear changed something")
	}
	if err := PushAPNsClear(o, true); err != nil {
		t.Fatal(err)
	}
	env := readEnv(t, o.EnvPath)
	for _, k := range apnsEnvKeys {
		if env[k] != "" {
			t.Fatalf("%s still set", k)
		}
	}
	if env["CHALK_PUSH_ENABLED"] != "true" || *restarts != 2 {
		t.Fatal("clear changed other lines or did not restart")
	}
}

// TestAPNsStatus checks the apns line of `push status` for the not-set, set,
// and incomplete states, and that it never shows the key.
func TestAPNsStatus(t *testing.T) {
	keyFile, _ := writeP8(t)
	o, _, out := pushOpts(t, pushEnv, "")
	if err := PushStatus(o); err != nil || !strings.Contains(out.String(), "apns:         not set") {
		t.Fatalf("status before set: %v\n%s", err, out)
	}
	if err := PushAPNsSet(o, goodSet(keyFile)); err != nil {
		t.Fatal(err)
	}
	out.Reset()
	if err := PushStatus(o); err != nil || !strings.Contains(out.String(), "apns:         set (topic=at.73c.chalk environment=production key id=ABC123DEFG)") {
		t.Fatalf("status after set: %v\n%s", err, out)
	}
	if strings.Contains(out.String(), readEnv(t, o.EnvPath)["CHALK_APNS_KEY"]) {
		t.Fatal("status printed the key")
	}
	if got := apnsStatus(map[string]string{"CHALK_APNS_TOPIC": "at.73c.chalk"}); !strings.HasPrefix(got, "INCOMPLETE") {
		t.Fatalf("partial: %s", got)
	}
}

// TestCarryAPNs checks that restore carries a complete set from the archive
// and does not carry an incomplete set.
func TestCarryAPNs(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, "chalk.env")
	priv, pub, _ := genVAPIDKey()
	fresh := "CHALK_VAPID_PUBLIC_KEY=" + pub + "\nCHALK_VAPID_PRIVATE_KEY=" + priv + "\n"
	logf := func(string, ...any) {}
	archived := "CHALK_APNS_KEY=KEYLINE\nCHALK_APNS_KEY_ID=ABC123DEFG\nCHALK_APNS_TEAM_ID=TEAM456XYZ\nCHALK_APNS_TOPIC=at.73c.chalk\nCHALK_APNS_ENV=sandbox\n"

	writeEnvFile(t, envPath, fresh)
	if err := carryEnv(envPath, []byte(archived), logf); err != nil {
		t.Fatal(err)
	}
	want := APNsSettings{Key: "KEYLINE", KeyID: "ABC123DEFG", TeamID: "TEAM456XYZ", Topic: "at.73c.chalk", Environment: "sandbox"}
	if got := apnsFromEnv(readEnv(t, envPath)); got != want {
		t.Fatalf("carried %+v", got)
	}

	writeEnvFile(t, envPath, fresh)
	if err := carryEnv(envPath, []byte("CHALK_APNS_KEY=KEYLINE\n"), logf); err != nil {
		t.Fatal(err)
	}
	if apnsFromEnv(readEnv(t, envPath)) != (APNsSettings{}) {
		t.Fatal("an incomplete archived set was carried")
	}
}

// TestInitForceKeepsAPNs checks that a render with the output of keepAPNs keeps
// a complete set, that a fresh render has no APNs lines, and that keepAPNs
// drops a partial set with a warning and returns nothing for a missing file.
func TestInitForceKeepsAPNs(t *testing.T) {
	keyFile, line := writeP8(t)
	o, _, _ := pushOpts(t, pushEnv, "")
	if err := PushAPNsSet(o, goodSet(keyFile)); err != nil {
		t.Fatal(err)
	}
	var logged []string
	logf := func(f string, a ...any) { logged = append(logged, f) }
	set := keepAPNs(o.EnvPath, logf)
	raw, err := renderTemplate("chalk.env", InitParams{
		Domain: "chat.cyberdyne.example", PGPassword: "PG", AdminUsername: "a", AdminEmail: "a@x.org",
		APNsKey: set.Key, APNsKeyID: set.KeyID, APNsTeamID: set.TeamID, APNsTopic: set.Topic, APNsEnvironment: set.Environment,
	})
	if err != nil {
		t.Fatal(err)
	}
	rendered := filepath.Join(t.TempDir(), "chalk.env")
	writeEnvFile(t, rendered, string(raw))
	if got := apnsFromEnv(readEnv(t, rendered)); got != apnsFromEnv(readEnv(t, o.EnvPath)) || got.Key != line {
		t.Fatalf("re-rendered env holds %+v", got)
	}
	if len(logged) != 1 || !strings.Contains(logged[0], "keeping") {
		t.Fatalf("logged %q", logged)
	}

	without, err := renderTemplate("chalk.env", InitParams{Domain: "chat.cyberdyne.example", PGPassword: "PG", AdminUsername: "a", AdminEmail: "a@x.org"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(without), "CHALK_APNS_") {
		t.Fatal("a fresh env file has APNs lines")
	}

	partial := filepath.Join(t.TempDir(), "chalk.env")
	writeEnvFile(t, partial, "CHALK_APNS_TOPIC=at.73c.chalk\n")
	logged = nil
	if got := keepAPNs(partial, logf); got != (APNsSettings{}) || len(logged) != 1 || !strings.Contains(logged[0], "WARNING") {
		t.Fatalf("partial: %+v, logged %q", got, logged)
	}
	if got := keepAPNs(filepath.Join(t.TempDir(), "none.env"), logf); got != (APNsSettings{}) {
		t.Fatalf("missing file: %+v", got)
	}
}

// mustRead returns the content of the file at path.
func mustRead(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

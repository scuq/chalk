package chalkctl

import (
	"archive/tar"
	"bytes"
	"crypto/rand"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const testPassword = "correct horse battery staple"

func sealBytes(t *testing.T, plain []byte, password string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w, err := newSealWriter(&buf, password)
	if err != nil {
		t.Fatalf("newSealWriter: %v", err)
	}
	if _, err := w.Write(plain); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := w.Close(); err != nil {
		t.Fatalf("close: %v", err)
	}
	return buf.Bytes()
}

func openBytes(t *testing.T, sealed []byte, password string) ([]byte, error) {
	t.Helper()
	r, err := newOpenReader(bytes.NewReader(sealed), password)
	if err != nil {
		return nil, err
	}
	return io.ReadAll(r)
}

// The archive is framed, so the boundaries are where it can go wrong: an empty
// payload still needs its final frame, and a payload that is an exact multiple
// of the chunk size must not look truncated.
func TestArchiveRoundTripAcrossFrameBoundaries(t *testing.T) {
	sizes := []int{0, 1000, archiveChunk, archiveChunk + 1}
	for _, n := range sizes {
		plain := make([]byte, n)
		if _, err := rand.Read(plain); err != nil {
			t.Fatal(err)
		}
		got, err := openBytes(t, sealBytes(t, plain, testPassword), testPassword)
		if err != nil {
			t.Fatalf("%d bytes: open: %v", n, err)
		}
		if !bytes.Equal(got, plain) {
			t.Fatalf("%d bytes: round trip mismatch (got %d bytes)", n, len(got))
		}
	}
}

func TestArchiveWrongPasswordAndTampering(t *testing.T) {
	sealed := sealBytes(t, []byte(strings.Repeat("secret ", 500)), testPassword)

	if _, err := openBytes(t, sealed, "not the password"); err != ErrArchivePassword {
		t.Fatalf("wrong password: want ErrArchivePassword, got %v", err)
	}

	// A flipped ciphertext bit must not decrypt to anything.
	flipped := append([]byte(nil), sealed...)
	flipped[len(flipped)-1] ^= 0x01
	if _, err := openBytes(t, flipped, testPassword); err == nil {
		t.Fatal("tampered ciphertext opened without error")
	}

	// Re-labelling the last frame as non-final (the shape of a splice attack)
	// changes the nonce, so it must not authenticate.
	relabelled := append([]byte(nil), sealed...)
	for i := archiveHeaderLen; i < len(relabelled); i++ {
		if relabelled[i] == 1 {
			relabelled[i] = 0
			break
		}
	}
	if _, err := openBytes(t, relabelled, testPassword); err == nil {
		t.Fatal("re-labelled final frame opened without error")
	}
}

// Truncation is the one corruption a per-frame tag cannot see; the final-frame
// marker is what catches it.
func TestArchiveTruncationDetected(t *testing.T) {
	plain := make([]byte, archiveChunk*2+17)
	if _, err := rand.Read(plain); err != nil {
		t.Fatal(err)
	}
	sealed := sealBytes(t, plain, testPassword)
	for _, cut := range []int{len(sealed) - 1, len(sealed) / 2, archiveHeaderLen} {
		if _, err := openBytes(t, sealed[:cut], testPassword); err == nil {
			t.Fatalf("truncation at %d opened without error", cut)
		}
	}
}

func TestArchiveRejectsForeignFile(t *testing.T) {
	_, err := newOpenReader(bytes.NewReader([]byte("this is not a chalk backup at all")), testPassword)
	if err == nil || !strings.Contains(err.Error(), "not a chalk backup") {
		t.Fatalf("want a bad-magic error, got %v", err)
	}
}

// The tar layout restore walks: manifest first (so it can describe the archive
// before touching anything), then env, then the optional config, then the dump.
func TestArchiveTarLayout(t *testing.T) {
	mf := Manifest{Format: ManifestFormat, Domain: "chat.example.org", ChalkVersion: "v0.5.8"}
	mfData, err := json.Marshal(mf)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	sealed, err := newSealWriter(&buf, testPassword)
	if err != nil {
		t.Fatal(err)
	}
	tw := tar.NewWriter(sealed)
	for _, m := range []struct {
		name string
		data string
	}{
		{manifestName, string(mfData)},
		{envName, "CHALK_TOTP_ENC_KEY=abc\n"},
		{confName, "DOMAIN=chat.example.org\n"},
	} {
		if err := tarBytes(tw, m.name, []byte(m.data)); err != nil {
			t.Fatal(err)
		}
	}
	dump := strings.Repeat("INSERT INTO messages VALUES (1);\n", 100)
	if err := tarStream(tw, dumpName, int64(len(dump)), strings.NewReader(dump)); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := sealed.Close(); err != nil {
		t.Fatal(err)
	}

	or, err := newOpenReader(bytes.NewReader(buf.Bytes()), testPassword)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(or)
	got, err := nextMember(tr, manifestName)
	if err != nil {
		t.Fatalf("manifest: %v", err)
	}
	var back Manifest
	if err := json.Unmarshal(got, &back); err != nil {
		t.Fatal(err)
	}
	if back.Domain != "chat.example.org" {
		t.Fatalf("manifest domain = %q", back.Domain)
	}
	if _, err := nextMember(tr, envName); err != nil {
		t.Fatalf("env: %v", err)
	}
	for _, want := range []string{confName, dumpName} {
		hdr, err := tr.Next()
		if err != nil {
			t.Fatalf("%s: %v", want, err)
		}
		if hdr.Name != want {
			t.Fatalf("member %q, want %s", hdr.Name, want)
		}
	}
}

func TestNextMemberRejectsWrongOrder(t *testing.T) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	if err := tarBytes(tw, dumpName, []byte("x")); err != nil {
		t.Fatal(err)
	}
	tw.Close()
	if _, err := nextMember(tar.NewReader(&buf), manifestName); err == nil {
		t.Fatal("nextMember accepted the wrong member")
	}
}

// The whole point of the restore's env handling: the TOTP key and (83-6)
// the server identity key come across -- the two values clients and stored
// ciphertext are bound to -- and the credentials belonging to the NEW host
// never do.
func TestCarriedEnvKeysAreIdentityOnly(t *testing.T) {
	want := []string{"CHALK_TOTP_ENC_KEY", "CHALK_SERVER_ID_KEY"}
	if len(carriedEnvKeys) != len(want) {
		t.Fatalf("carriedEnvKeys = %v; carrying anything else moves the old host's credentials onto the new one", carriedEnvKeys)
	}
	for i, k := range want {
		if carriedEnvKeys[i] != k {
			t.Fatalf("carriedEnvKeys = %v, want %v", carriedEnvKeys, want)
		}
	}
}

func TestSetEnvValue(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "chalk.env")
	const original = "# comment\nCHALK_PG_PASSWORD=newhost\nCHALK_TOTP_ENC_KEY=fresh\nCHALK_RP_ID=new.example.org\n"
	if err := os.WriteFile(path, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}

	changed, err := setEnvValue(path, "CHALK_TOTP_ENC_KEY", "fromBackup")
	if err != nil {
		t.Fatal(err)
	}
	if !changed {
		t.Fatal("replacing a value reported no change")
	}
	env := readEnvOrFail(t, path)
	if env["CHALK_TOTP_ENC_KEY"] != "fromBackup" {
		t.Fatalf("TOTP key = %q", env["CHALK_TOTP_ENC_KEY"])
	}
	if env["CHALK_PG_PASSWORD"] != "newhost" || env["CHALK_RP_ID"] != "new.example.org" {
		t.Fatalf("restore disturbed neighbouring keys: %v", env)
	}

	// Re-applying the same value is a no-op, so a repeated restore doesn't
	// churn the file.
	if changed, err := setEnvValue(path, "CHALK_TOTP_ENC_KEY", "fromBackup"); err != nil || changed {
		t.Fatalf("idempotent write: changed=%v err=%v", changed, err)
	}

	// A key the file lacks is appended (an env file predating the value).
	if _, err := setEnvValue(path, "CHALK_NEW_KNOB", "1"); err != nil {
		t.Fatal(err)
	}
	if readEnvOrFail(t, path)["CHALK_NEW_KNOB"] != "1" {
		t.Fatal("appended key not readable back")
	}

	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("env file mode = %v, want 0600 (it holds secrets)", fi.Mode().Perm())
	}
}

func readEnvOrFail(t *testing.T, path string) map[string]string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return parseEnvBytes(b)
}

func TestCarryEnvWarnsWhenKeyMissing(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "chalk.env")
	if err := os.WriteFile(path, []byte("CHALK_TOTP_ENC_KEY=fresh\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var log strings.Builder
	logf := func(f string, a ...any) {
		log.WriteString(strings.TrimSpace(strings.ReplaceAll(f, "%s", "%v")) + "\n")
		_ = a
	}
	if err := carryEnv(path, []byte("CHALK_PG_PASSWORD=old\n"), logf); err != nil {
		t.Fatalf("carryEnv: %v", err)
	}
	if !strings.Contains(log.String(), "WARNING") {
		t.Fatalf("a backup without the TOTP key must warn; log was %q", log.String())
	}
	if readEnvOrFail(t, path)["CHALK_TOTP_ENC_KEY"] != "fresh" {
		t.Fatal("a missing archived key must leave the live one alone")
	}
}

func TestHumanBytes(t *testing.T) {
	cases := map[int64]string{
		0: "0 B", 512: "512 B", 2048: "2.0 KiB", 5 << 20: "5.0 MiB", 3 << 30: "3.0 GiB",
		1 << 50: "1.0 PiB", // the unit string must cover every int64, not just plausible sizes
	}
	for in, want := range cases {
		if got := humanBytes(in); got != want {
			t.Fatalf("humanBytes(%d) = %q, want %q", in, got, want)
		}
	}
}

func TestResolveBackupPasswordFromFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "pw")
	// Trailing newline is stripped; a trailing space is part of the password.
	if err := os.WriteFile(path, []byte("a long enough pass \n"), 0o600); err != nil {
		t.Fatal(err)
	}
	pw, err := ResolveBackupPassword(path, true)
	if err != nil {
		t.Fatal(err)
	}
	if pw != "a long enough pass " {
		t.Fatalf("password = %q", pw)
	}

	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := ResolveBackupPassword(path, true); err == nil {
		t.Fatal("empty password file accepted")
	}
}

func TestResolveBackupPasswordFromEnv(t *testing.T) {
	t.Setenv(BackupPasswordEnv, "from the environment")
	pw, err := ResolveBackupPassword("", true)
	if err != nil {
		t.Fatal(err)
	}
	if pw != "from the environment" {
		t.Fatalf("password = %q", pw)
	}
}

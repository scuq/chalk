package chalkctl

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestEnvRendersOutboundIPv4Only checks that the env template writes the
// CHALK_OUTBOUND_IPV4_ONLY line for both values.
func TestEnvRendersOutboundIPv4Only(t *testing.T) {
	for _, on := range []bool{false, true} {
		p := InitParams{
			Domain: "chat.cyberdyne.example", Image: "ghcr.io/x/chalk", Version: "v1", Digest: "sha256:d",
			OutboundIPv4Only: on,
		}
		env, err := renderTemplate("chalk.env", p)
		if err != nil {
			t.Fatal(err)
		}
		want := "CHALK_OUTBOUND_IPV4_ONLY=false\n"
		if on {
			want = "CHALK_OUTBOUND_IPV4_ONLY=true\n"
		}
		if !strings.Contains(string(env), want) {
			t.Errorf("env file lacks %q", want)
		}
	}
}

// TestOutboundConfigRoundTrip checks that the default is off and that Save
// and LoadConfigFile keep OUTBOUND_IPV4_ONLY.
func TestOutboundConfigRoundTrip(t *testing.T) {
	p := filepath.Join(t.TempDir(), "c.conf")
	in := DefaultConfig()
	if in.OutboundIPv4Only {
		t.Fatal("init must default IPv4 only off")
	}
	in.Domain = "chat.cyberdyne.example"
	in.OutboundIPv4Only = true
	if err := in.Save(p); err != nil {
		t.Fatal(err)
	}
	out, err := LoadConfigFile(DefaultConfig(), p)
	if err != nil {
		t.Fatal(err)
	}
	if !out.OutboundIPv4Only {
		t.Fatalf("round trip lost OUTBOUND_IPV4_ONLY: %+v", out)
	}
}

// TestEnsureOutboundEnv checks that the backfill adds one line to the env file
// and one to the config file, also when it runs twice.
func TestEnsureOutboundEnv(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, "chalk.env")
	cfgPath := filepath.Join(dir, "chalkctl.conf")
	writeEnvFile(t, envPath, "CHALK_PUSH_ENABLED=true\n")
	writeEnvFile(t, cfgPath, "DOMAIN=chat.cyberdyne.example\n")

	for i := 0; i < 2; i++ {
		if err := ensureOutboundEnv(envPath, cfgPath, io.Discard); err != nil {
			t.Fatal(err)
		}
	}
	if v := readEnv(t, envPath)["CHALK_OUTBOUND_IPV4_ONLY"]; v != "false" {
		t.Fatalf("env value = %q, want false", v)
	}
	if v := readEnv(t, cfgPath)["OUTBOUND_IPV4_ONLY"]; v != "false" {
		t.Fatalf("config value = %q, want false", v)
	}
	for _, path := range []string{envPath, cfgPath} {
		b, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		if n := strings.Count(string(b), "OUTBOUND_IPV4_ONLY="); n != 1 {
			t.Fatalf("%s has %d OUTBOUND_IPV4_ONLY lines, want 1", path, n)
		}
	}
}

// TestEnsureOutboundEnvKeepsOperatorChoice checks that the backfill does not
// change a present value and does not create a missing config file.
func TestEnsureOutboundEnvKeepsOperatorChoice(t *testing.T) {
	dir := t.TempDir()
	envPath := filepath.Join(dir, "chalk.env")
	cfgPath := filepath.Join(dir, "chalkctl.conf")
	writeEnvFile(t, envPath, "CHALK_OUTBOUND_IPV4_ONLY=true\n")
	writeEnvFile(t, cfgPath, "DOMAIN=chat.cyberdyne.example\n")

	if err := ensureOutboundEnv(envPath, cfgPath, io.Discard); err != nil {
		t.Fatal(err)
	}
	if v := readEnv(t, envPath)["CHALK_OUTBOUND_IPV4_ONLY"]; v != "true" {
		t.Fatalf("operator value changed to %q", v)
	}
	if _, ok := readEnv(t, cfgPath)["OUTBOUND_IPV4_ONLY"]; ok {
		t.Fatal("the config file changed although the env file had a value")
	}

	missing := filepath.Join(dir, "missing.conf")
	writeEnvFile(t, envPath, "CHALK_PUSH_ENABLED=true\n")
	if err := ensureOutboundEnv(envPath, missing, io.Discard); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(missing); err == nil {
		t.Fatal("a missing config file was created")
	}
}

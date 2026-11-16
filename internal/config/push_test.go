package config

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"testing"

	"github.com/scuq/chalk/internal/webpush"
)

func TestPushDefaults(t *testing.T) {
	p := defaultPushConfig()
	if p.Enabled {
		t.Fatal("push must default to disabled")
	}
	if err := p.Validate(); err != nil {
		t.Fatalf("default config must validate: %v", err)
	}
}

func TestPushApplyEnv(t *testing.T) {
	t.Setenv("CHALK_PUSH_ENABLED", "true")
	t.Setenv("CHALK_VAPID_PUBLIC_KEY", " pub ")
	t.Setenv("CHALK_VAPID_PRIVATE_KEY", "priv")
	t.Setenv("CHALK_VAPID_SUBJECT", "https://chat.cyberdyne.example")
	p := defaultPushConfig()
	p.applyEnv()
	if !p.Enabled || p.PublicKey != "pub" || p.PrivateKey != "priv" || p.Subject != "https://chat.cyberdyne.example" {
		t.Fatalf("env not applied: %+v", p)
	}
}

func TestPushValidate(t *testing.T) {
	priv, pub, err := webpush.GenerateVAPIDKey()
	if err != nil {
		t.Fatal(err)
	}
	_, otherPub, _ := webpush.GenerateVAPIDKey()
	good := PushConfig{Enabled: true, PublicKey: pub, PrivateKey: priv, Subject: "mailto:admin@cyberdyne.example"}
	cases := []struct {
		name string
		mut  func(*PushConfig)
		ok   bool
	}{
		{"good", func(*PushConfig) {}, true},
		{"disabled ignores keys", func(p *PushConfig) { *p = PushConfig{PrivateKey: "junk"} }, true},
		{"missing public", func(p *PushConfig) { p.PublicKey = "" }, false},
		{"missing private", func(p *PushConfig) { p.PrivateKey = "" }, false},
		{"missing subject", func(p *PushConfig) { p.Subject = "" }, false},
		{"bad subject", func(p *PushConfig) { p.Subject = "http://chat.cyberdyne.example" }, false},
		{"bad private", func(p *PushConfig) { p.PrivateKey = "AAAA" }, false},
		{"mismatched public", func(p *PushConfig) { p.PublicKey = otherPub }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := good
			tc.mut(&p)
			err := p.Validate()
			if tc.ok && err != nil {
				t.Fatalf("want ok, got %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("want error, got nil")
			}
		})
	}
}

func TestAPNsApplyEnv(t *testing.T) {
	t.Setenv("CHALK_APNS_KEY", " key ")
	t.Setenv("CHALK_APNS_KEY_ID", "ABC123DEFG")
	t.Setenv("CHALK_APNS_TEAM_ID", "TEAM456XYZ")
	t.Setenv("CHALK_APNS_TOPIC", "at.73c.chalk")
	t.Setenv("CHALK_APNS_ENV", "sandbox")
	p := defaultPushConfig()
	if p.APNs.Configured() {
		t.Fatal("APNs must default to not configured")
	}
	p.applyEnv()
	want := APNsConfig{Key: "key", KeyID: "ABC123DEFG", TeamID: "TEAM456XYZ", Topic: "at.73c.chalk", Environment: "sandbox"}
	if p.APNs != want {
		t.Fatalf("env not applied: %+v", p.APNs)
	}
}

func TestAPNsValidate(t *testing.T) {
	ec, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(ec)
	if err != nil {
		t.Fatal(err)
	}
	priv, pub, err := webpush.GenerateVAPIDKey()
	if err != nil {
		t.Fatal(err)
	}
	good := PushConfig{
		Enabled: true, PublicKey: pub, PrivateKey: priv, Subject: "mailto:admin@cyberdyne.example",
		APNs: APNsConfig{Key: base64.StdEncoding.EncodeToString(der), KeyID: "ABC123DEFG", TeamID: "TEAM456XYZ", Topic: "at.73c.chalk"},
	}
	cases := []struct {
		name string
		mut  func(*PushConfig)
		ok   bool
	}{
		{"good, default environment", func(*PushConfig) {}, true},
		{"sandbox", func(p *PushConfig) { p.APNs.Environment = "sandbox" }, true},
		{"not configured", func(p *PushConfig) { p.APNs = APNsConfig{} }, true},
		{"environment alone is not configured", func(p *PushConfig) { p.APNs = APNsConfig{Environment: "sandbox"} }, true},
		{"push disabled ignores APNs", func(p *PushConfig) { p.Enabled = false; p.APNs.Key = "junk" }, true},
		{"missing key", func(p *PushConfig) { p.APNs.Key = "" }, false},
		{"missing key id", func(p *PushConfig) { p.APNs.KeyID = "" }, false},
		{"missing team id", func(p *PushConfig) { p.APNs.TeamID = "" }, false},
		{"missing topic", func(p *PushConfig) { p.APNs.Topic = "" }, false},
		{"bad key", func(p *PushConfig) { p.APNs.Key = "AAAA" }, false},
		{"bad topic", func(p *PushConfig) { p.APNs.Topic = "at 73c" }, false},
		{"bad environment", func(p *PushConfig) { p.APNs.Environment = "staging" }, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := good
			tc.mut(&p)
			err := p.Validate()
			if tc.ok && err != nil {
				t.Fatalf("want ok, got %v", err)
			}
			if !tc.ok && err == nil {
				t.Fatal("want an error")
			}
		})
	}
	if _, err := good.APNs.ParseKey(); err != nil {
		t.Fatal(err)
	}
}

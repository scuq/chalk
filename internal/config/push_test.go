package config

import (
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

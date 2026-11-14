package server

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"strings"
	"testing"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/store"
)

func validSubscribe(t *testing.T) proto.PushSubscribePayload {
	t.Helper()
	ua, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	_, _ = rand.Read(auth)
	return proto.PushSubscribePayload{
		Endpoint:       "https://push.cyberdyne.example/send/abc",
		P256dh:         base64.RawURLEncoding.EncodeToString(ua.PublicKey().Bytes()),
		Auth:           base64.RawURLEncoding.EncodeToString(auth),
		Scope:          "dms",
		VAPIDPublicKey: "KEY",
	}
}

func TestParsePushSubscribe(t *testing.T) {
	good := validSubscribe(t)
	if sub, code, msg := parsePushSubscribe(good, "KEY"); code != "" || len(sub.p256dh) != 65 || len(sub.auth) != 16 || sub.scope != store.PushScopeDMs {
		t.Fatalf("valid payload refused: %s %s", code, msg)
	}
	padded := good
	padded.Auth += "=="
	padded.VAPIDPublicKey = "KEY="
	if _, code, msg := parsePushSubscribe(padded, "KEY"); code != "" {
		t.Fatalf("padded base64url refused: %s %s", code, msg)
	}

	offCurve := make([]byte, 65)
	offCurve[0] = 4
	cases := []struct {
		name string
		mut  func(*proto.PushSubscribePayload)
		code string
	}{
		{"other key", func(p *proto.PushSubscribePayload) { p.VAPIDPublicKey = "OLD" }, proto.ErrCodePushKeyStale},
		{"no key", func(p *proto.PushSubscribePayload) { p.VAPIDPublicKey = "" }, proto.ErrCodePushKeyStale},
		{"http endpoint", func(p *proto.PushSubscribePayload) { p.Endpoint = "http://push.cyberdyne.example/a" }, proto.ErrCodeBadPayload},
		{"long endpoint", func(p *proto.PushSubscribePayload) {
			p.Endpoint = "https://push.cyberdyne.example/" + strings.Repeat("a", maxPushEndpointLen)
		}, proto.ErrCodeBadPayload},
		{"short p256dh", func(p *proto.PushSubscribePayload) { p.P256dh = p.P256dh[:20] }, proto.ErrCodeBadPayload},
		{"off-curve p256dh", func(p *proto.PushSubscribePayload) {
			p.P256dh = base64.RawURLEncoding.EncodeToString(offCurve)
		}, proto.ErrCodeBadPayload},
		{"std base64 auth", func(p *proto.PushSubscribePayload) { p.Auth = "a+b/" + p.Auth[4:] }, proto.ErrCodeBadPayload},
		{"short auth", func(p *proto.PushSubscribePayload) { p.Auth = "AAAA" }, proto.ErrCodeBadPayload},
		{"bad scope", func(p *proto.PushSubscribePayload) { p.Scope = "loud" }, proto.ErrCodeBadPayload},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			p := good
			tc.mut(&p)
			if _, code, _ := parsePushSubscribe(p, "KEY"); code != tc.code {
				t.Fatalf("code = %q, want %q", code, tc.code)
			}
		})
	}
}

func TestPushStatePayload(t *testing.T) {
	if st := pushStatePayload("", nil); st.Enabled || st.VAPIDPublicKey != "" || st.Subscribed || st.KeyCurrent {
		t.Fatalf("disabled, no subscription: %+v", st)
	}
	sub := &store.PushSubscription{Endpoint: "https://push.cyberdyne.example/a", Scope: store.PushScopeAll, VAPIDKey: "KEY"}
	st := pushStatePayload("KEY", sub)
	if !st.Enabled || st.VAPIDPublicKey != "KEY" || !st.Subscribed || st.Scope != "all" || !st.KeyCurrent {
		t.Fatalf("current subscription: %+v", st)
	}
	if st := pushStatePayload("NEW", sub); st.KeyCurrent || !st.Subscribed {
		t.Fatalf("stale subscription: %+v", st)
	}
	if st := pushStatePayload("", sub); st.KeyCurrent || st.Enabled {
		t.Fatalf("subscription while disabled: %+v", st)
	}
}

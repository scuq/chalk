package auth

// 80-8: the join endpoints' HTTP semantics, against a fake store (the
// materialization transaction itself is covered in
// internal/store/ephemeral_redeem_test.go against a real Postgres).

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"log"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/store"
)

type fakeJoinStore struct {
	invites   map[string]store.EphemeralInvite // keyed by hex-agnostic string(lookup)
	redeemErr error
	redeems   []store.RedeemInput
}

func (f *fakeJoinStore) GetEphemeralInvite(_ context.Context, lookup []byte) (store.EphemeralInvite, error) {
	inv, ok := f.invites[string(lookup)]
	if !ok {
		return store.EphemeralInvite{}, store.ErrNotFound
	}
	return inv, nil
}

func (f *fakeJoinStore) RedeemEphemeralInvite(_ context.Context, in store.RedeemInput) (store.RedeemedGuest, error) {
	if f.redeemErr != nil {
		return store.RedeemedGuest{}, f.redeemErr
	}
	f.redeems = append(f.redeems, in)
	inv := f.invites[string(in.Lookup)]
	return store.RedeemedGuest{
		UserID:           inv.GuestUserID,
		DisplayName:      in.DisplayName,
		ChannelID:        inv.ChannelID,
		ChannelName:      "quick call",
		ChannelExpiresAt: time.Now().Add(time.Hour),
		KeyVersion:       1,
		WrapSuite:        1,
		WrapBlob:         []byte{1, 2, 3},
		SessionToken:     bytes.Repeat([]byte{9}, 32),
		SessionExpiresAt: time.Now().Add(time.Hour),
	}, nil
}

func joinTestServer(t *testing.T, f *fakeJoinStore) (*HTTPDeps, *httptest.Server) {
	t.Helper()
	d := &HTTPDeps{EphemeralEnabled: true, JoinStore: f, Logger: log.Default()}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/join/{lookup}", d.handleJoinChallenge)
	mux.HandleFunc("POST /api/join/{lookup}", d.handleJoinRedeem)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return d, srv
}

func getChallenge(t *testing.T, srv *httptest.Server, lookupHex string) (string, int, map[string]any) {
	t.Helper()
	resp, err := http.Get(srv.URL + "/api/join/" + lookupHex)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&body)
	ch, _ := body["challenge"].(string)
	return ch, resp.StatusCode, body
}

func postRedeem(t *testing.T, srv *httptest.Server, lookupHex string, req joinRedeemRequest) (*http.Response, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(req)
	resp, err := http.Post(srv.URL+"/api/join/"+lookupHex, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&body)
	return resp, body
}

const (
	knownHex   = "00112233445566778899aabbccddeeff"
	unknownHex = "ffeeddccbbaa99887766554433221100"
)

func newFakeWithKey(t *testing.T) (*fakeJoinStore, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	lookup, _ := hexDecode(knownHex)
	return &fakeJoinStore{invites: map[string]store.EphemeralInvite{
		string(lookup): {
			Lookup:      lookup,
			ChannelID:   uuid.New(),
			GuestUserID: uuid.New(),
			Ed25519Pub:  pub,
			ExpiresAt:   time.Now().Add(time.Hour),
		},
	}}, priv
}

// errCode digs the stable code out of the nested error body.
func errCode(body map[string]any) string {
	e, _ := body["error"].(map[string]any)
	c, _ := e["code"].(string)
	return c
}

func hexDecode(s string) ([]byte, error) {
	return hex.DecodeString(s)
}

func signChallenge(t *testing.T, priv ed25519.PrivateKey, challengeB64 string) string {
	t.Helper()
	ch, err := base64.StdEncoding.DecodeString(challengeB64)
	if err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(ed25519.Sign(priv, ch))
}

func TestJoinChallengeUnconditional(t *testing.T) {
	_, srv := joinTestServer(t, &fakeJoinStore{invites: map[string]store.EphemeralInvite{}})

	// Known-or-not, the answer has the same status and the same shape; invite
	// existence is unobservable from the challenge phase.
	_, code1, body1 := getChallenge(t, srv, knownHex)
	_, code2, body2 := getChallenge(t, srv, unknownHex)
	if code1 != http.StatusOK || code2 != http.StatusOK {
		t.Fatalf("challenge status: %d / %d, want 200 / 200", code1, code2)
	}
	for _, body := range []map[string]any{body1, body2} {
		if body["challenge"] == "" || body["expires_in_secs"] == nil {
			t.Fatalf("challenge body shape differs: %v", body)
		}
	}
}

func TestJoinRedeemHappyPathAndReplay(t *testing.T) {
	f, priv := newFakeWithKey(t)
	_, srv := joinTestServer(t, f)

	ch, _, _ := getChallenge(t, srv, knownHex)
	req := joinRedeemRequest{
		Challenge:   ch,
		Signature:   signChallenge(t, priv, ch),
		DisplayName: "Bob",
	}
	resp, body := postRedeem(t, srv, knownHex, req)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("redeem: %d %v", resp.StatusCode, body)
	}
	if body["channel_name"] != "quick call" || body["wrap_blob"] == "" {
		t.Errorf("redeem body: %v", body)
	}
	var cookie *http.Cookie
	for _, c := range resp.Cookies() {
		if c.Name == GuestCookieName {
			cookie = c
		}
	}
	if cookie == nil || cookie.Value == "" || !cookie.HttpOnly || cookie.SameSite != http.SameSiteLaxMode {
		t.Errorf("guest cookie wrong: %+v", cookie)
	}
	if len(f.redeems) != 1 || f.redeems[0].DisplayName != "Bob" {
		t.Errorf("store saw: %+v", f.redeems)
	}

	// A captured redemption body replayed verbatim is refused.
	resp2, body2 := postRedeem(t, srv, knownHex, req)
	if resp2.StatusCode != http.StatusForbidden || errCode(body2) != "challenge_replayed" {
		t.Errorf("replay: %d %v, want 403 challenge_replayed", resp2.StatusCode, body2)
	}
	if len(f.redeems) != 1 {
		t.Errorf("replay reached the store: %+v", f.redeems)
	}
}

func TestJoinRedeemWrongKeyAndUnknownIndistinguishable(t *testing.T) {
	f, _ := newFakeWithKey(t)
	_, srv := joinTestServer(t, f)
	_, wrongPriv, _ := ed25519.GenerateKey(nil)

	// Wrong key on a KNOWN lookup.
	ch1, _, _ := getChallenge(t, srv, knownHex)
	respKnown, bodyKnown := postRedeem(t, srv, knownHex, joinRedeemRequest{
		Challenge: ch1, Signature: signChallenge(t, wrongPriv, ch1), DisplayName: "Eve",
	})
	// Any key on an UNKNOWN lookup.
	ch2, _, _ := getChallenge(t, srv, unknownHex)
	respUnknown, bodyUnknown := postRedeem(t, srv, unknownHex, joinRedeemRequest{
		Challenge: ch2, Signature: signChallenge(t, wrongPriv, ch2), DisplayName: "Eve",
	})

	if respKnown.StatusCode != http.StatusForbidden || respUnknown.StatusCode != http.StatusForbidden {
		t.Fatalf("status: %d / %d, want 403 / 403", respKnown.StatusCode, respUnknown.StatusCode)
	}
	if errCode(bodyKnown) != errCode(bodyUnknown) || errCode(bodyKnown) != "bad_signature" {
		t.Errorf("bodies must be identical bad_signature: %v vs %v", bodyKnown, bodyUnknown)
	}
	if len(f.redeems) != 0 {
		t.Errorf("failed verification reached the store")
	}
}

func TestJoinRedeemExpiredInvite(t *testing.T) {
	f, priv := newFakeWithKey(t)
	f.redeemErr = store.ErrInviteExpired
	_, srv := joinTestServer(t, f)

	ch, _, _ := getChallenge(t, srv, knownHex)
	resp, body := postRedeem(t, srv, knownHex, joinRedeemRequest{
		Challenge: ch, Signature: signChallenge(t, priv, ch), DisplayName: "Bob",
	})
	if resp.StatusCode != http.StatusGone || errCode(body) != "invite_gone" {
		t.Errorf("expired: %d %v, want 410 invite_gone", resp.StatusCode, body)
	}

	f.redeemErr = store.ErrInviteRevoked
	ch2, _, _ := getChallenge(t, srv, knownHex)
	resp2, _ := postRedeem(t, srv, knownHex, joinRedeemRequest{
		Challenge: ch2, Signature: signChallenge(t, priv, ch2), DisplayName: "Bob",
	})
	if resp2.StatusCode != http.StatusGone {
		t.Errorf("revoked: %d, want 410", resp2.StatusCode)
	}
}

func TestJoinChallengeExpiryAndBinding(t *testing.T) {
	f, priv := newFakeWithKey(t)
	d, srv := joinTestServer(t, f)
	d.join.init()
	lookup, _ := hexDecode(knownHex)

	// A challenge past its TTL is refused even with a valid signature.
	old := base64.StdEncoding.EncodeToString(
		d.join.challenge(lookup, time.Now().Add(-3*time.Minute)))
	resp, body := postRedeem(t, srv, knownHex, joinRedeemRequest{
		Challenge: old, Signature: signChallenge(t, priv, old), DisplayName: "Bob",
	})
	if resp.StatusCode != http.StatusForbidden || errCode(body) != "bad_challenge" {
		t.Errorf("stale challenge: %d %v", resp.StatusCode, body)
	}

	// A challenge minted for ANOTHER lookup does not verify for this one.
	otherLookup, _ := hexDecode(unknownHex)
	crossed := base64.StdEncoding.EncodeToString(
		d.join.challenge(otherLookup, time.Now()))
	resp2, body2 := postRedeem(t, srv, knownHex, joinRedeemRequest{
		Challenge: crossed, Signature: signChallenge(t, priv, crossed), DisplayName: "Bob",
	})
	if resp2.StatusCode != http.StatusForbidden || errCode(body2) != "bad_challenge" {
		t.Errorf("cross-lookup challenge: %d %v", resp2.StatusCode, body2)
	}
}

func TestJoinDisabledIs404(t *testing.T) {
	f, _ := newFakeWithKey(t)
	d, srv := joinTestServer(t, f)
	d.EphemeralEnabled = false
	_, code, _ := getChallenge(t, srv, knownHex)
	if code != http.StatusNotFound {
		t.Errorf("disabled GET: %d, want 404", code)
	}
	resp, _ := postRedeem(t, srv, knownHex, joinRedeemRequest{DisplayName: "x"})
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("disabled POST: %d, want 404", resp.StatusCode)
	}
}

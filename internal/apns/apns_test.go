// Tests for package apns. They send to a local TLS server and never reach the
// real APNs. The values in the constants are placeholders.
package apns

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const (
	testKeyID  = "ABC123DEFG"
	testTeamID = "TEAM456XYZ"
	testTopic  = "at.73c.chalk"
	testToken  = "00fc13adff785122b4ad28809a3420982341241421348097878e577c991de8f0"
)

// newP8 returns a new P-256 key as a PEM-encoded PKCS#8 block, like a .p8 file
// of Apple, and the key itself.
func newP8(t *testing.T) (string, *ecdsa.PrivateKey) {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), priv
}

// pemBody returns the base64 body of p8 on one line, without the PEM header
// and footer lines.
func pemBody(p8 string) string {
	var lines []string
	for _, l := range strings.Split(strings.TrimSpace(p8), "\n") {
		if !strings.HasPrefix(l, "-----") {
			lines = append(lines, l)
		}
	}
	return strings.Join(lines, "")
}

// TestParseKey checks that ParseKey accepts a key as PEM and as bare base64,
// and refuses a bad key id, a bad team id, bad input, and a key of another
// curve.
func TestParseKey(t *testing.T) {
	p8, _ := newP8(t)
	for name, in := range map[string]string{
		"pem":             p8,
		"pem with spaces": "\n  " + p8 + "\n",
		"bare base64":     pemBody(p8),
		"wrapped base64":  strings.Join(strings.Split(pemBody(p8), "A"), "A\n "),
	} {
		if _, err := ParseKey(in, testKeyID, testTeamID); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}

	_, edPriv, _ := ed25519.GenerateKey(rand.Reader)
	edDER, _ := x509.MarshalPKCS8PrivateKey(edPriv)
	p384, _ := ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
	p384DER, _ := x509.MarshalPKCS8PrivateKey(p384)
	bad := []struct{ name, p8, keyID, teamID string }{
		{"empty key", "", testKeyID, testTeamID},
		{"garbage", "not base64 !!", testKeyID, testTeamID},
		{"bad pem", "-----BEGIN PRIVATE KEY-----\n!!\n-----END PRIVATE KEY-----", testKeyID, testTeamID},
		{"not pkcs8", base64.StdEncoding.EncodeToString([]byte("hello")), testKeyID, testTeamID},
		{"ed25519", base64.StdEncoding.EncodeToString(edDER), testKeyID, testTeamID},
		{"p-384", base64.StdEncoding.EncodeToString(p384DER), testKeyID, testTeamID},
		{"short key id", p8, "ABC", testTeamID},
		{"key id with dash", p8, "ABC123-EFG", testTeamID},
		{"empty team id", p8, testKeyID, ""},
		{"long team id", p8, testKeyID, "TEAM456XYZ1"},
	}
	for _, tc := range bad {
		if _, err := ParseKey(tc.p8, tc.keyID, tc.teamID); err == nil {
			t.Fatalf("%s: want an error", tc.name)
		}
	}
}

// verifyToken checks the header, the claims, and the ES256 signature of the
// provider token in authz against pub. It returns the claims iss and iat.
func verifyToken(t *testing.T, authz string, pub *ecdsa.PublicKey) (iss string, iat int64) {
	t.Helper()
	jwt, ok := strings.CutPrefix(authz, "bearer ")
	if !ok {
		t.Fatalf("authorization = %q", authz)
	}
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		t.Fatalf("token has %d parts", len(parts))
	}
	b64 := base64.RawURLEncoding
	headerJSON, err := b64.DecodeString(parts[0])
	if err != nil {
		t.Fatal(err)
	}
	var header struct{ Alg, Kid, Typ string }
	if err := json.Unmarshal(headerJSON, &header); err != nil {
		t.Fatal(err)
	}
	if header.Alg != "ES256" || header.Kid != testKeyID {
		t.Fatalf("header = %s", headerJSON)
	}
	claimsJSON, err := b64.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims struct {
		Iss string
		Iat int64
	}
	if err := json.Unmarshal(claimsJSON, &claims); err != nil {
		t.Fatal(err)
	}
	sig, err := b64.DecodeString(parts[2])
	if err != nil || len(sig) != 64 {
		t.Fatalf("signature: %d bytes, %v", len(sig), err)
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if !ecdsa.Verify(pub, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("signature does not verify")
	}
	return claims.Iss, claims.Iat
}

// TestProviderToken checks that the provider token is cached, renewed after
// tokenRenew, dropped by forget, and replaced when the clock goes back.
func TestProviderToken(t *testing.T) {
	p8, priv := newP8(t)
	k, err := ParseKey(p8, testKeyID, testTeamID)
	if err != nil {
		t.Fatal(err)
	}
	t0 := time.Unix(1_800_000_000, 0)

	first, err := k.authorization(t0)
	if err != nil {
		t.Fatal(err)
	}
	iss, iat := verifyToken(t, first, &priv.PublicKey)
	if iss != testTeamID || iat != t0.Unix() {
		t.Fatalf("claims: iss=%q iat=%d", iss, iat)
	}

	again, _ := k.authorization(t0.Add(tokenRenew - time.Second))
	if again != first {
		t.Fatal("token was not reused inside the renew time")
	}

	renewed, _ := k.authorization(t0.Add(tokenRenew))
	if renewed == first {
		t.Fatal("token was not renewed")
	}
	if _, iat := verifyToken(t, renewed, &priv.PublicKey); iat != t0.Add(tokenRenew).Unix() {
		t.Fatalf("renewed iat = %d", iat)
	}

	k.forget(first)
	if kept, _ := k.authorization(t0.Add(tokenRenew)); kept != renewed {
		t.Fatal("forget of an old token dropped the current one")
	}
	k.forget(renewed)
	if fresh, _ := k.authorization(t0.Add(tokenRenew)); fresh == renewed {
		t.Fatal("forget did not drop the current token")
	}

	back, _ := k.authorization(t0.Add(-time.Hour))
	if _, iat := verifyToken(t, back, &priv.PublicKey); iat != t0.Add(-time.Hour).Unix() {
		t.Fatal("a clock that went back did not give a new token")
	}
}

// TestValidate checks ValidateToken and ValidateTopic.
func TestValidate(t *testing.T) {
	for _, ok := range []string{testToken, strings.ToUpper(testToken), "ab", strings.Repeat("a", maxTokenLen)} {
		if err := ValidateToken(ok); err != nil {
			t.Fatalf("token %q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "xyz", "ab/../cd", "ab cd", strings.Repeat("a", maxTokenLen+1)} {
		if err := ValidateToken(bad); !errors.Is(err, ErrToken) {
			t.Fatalf("token %q: %v", bad, err)
		}
	}
	for _, ok := range []string{testTopic, "com.example.My-App"} {
		if err := ValidateTopic(ok); err != nil {
			t.Fatalf("topic %q: %v", ok, err)
		}
	}
	for _, bad := range []string{"", "at.73c.chalk\n", "a b", "a/b", strings.Repeat("a", 256)} {
		if err := ValidateTopic(bad); err == nil {
			t.Fatalf("topic %q: want an error", bad)
		}
	}
}

// TestEnvironment checks ParseEnvironment and the host of each Environment.
func TestEnvironment(t *testing.T) {
	for in, want := range map[string]Environment{"": Production, "production": Production, "sandbox": Sandbox} {
		got, err := ParseEnvironment(in)
		if err != nil || got != want {
			t.Fatalf("ParseEnvironment(%q) = %q, %v", in, got, err)
		}
	}
	if _, err := ParseEnvironment("staging"); err == nil {
		t.Fatal("want an error for an unknown environment")
	}
	if Production.host() != "https://api.push.apple.com" || Sandbox.host() != "https://api.sandbox.push.apple.com" {
		t.Fatalf("hosts: %s, %s", Production.host(), Sandbox.host())
	}
}

// newDevice returns a Device with a new P-256 key and authentication secret,
// and the private key of the device.
func newDevice(t *testing.T) (Device, *ecdh.PrivateKey) {
	t.Helper()
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	if _, err := rand.Read(auth); err != nil {
		t.Fatal(err)
	}
	return Device{Token: testToken, P256dh: priv.PublicKey().Bytes(), Auth: auth}, priv
}

// open is the receiver side of RFC 8291. It returns the payload without the
// delimiter and the padding.
func open(t *testing.T, body []byte, devPriv *ecdh.PrivateKey, auth []byte) []byte {
	t.Helper()
	salt := body[:16]
	idLen := int(body[20])
	asPubRaw := body[21 : 21+idLen]
	ct := body[21+idLen:]
	asPub, err := ecdh.P256().NewPublicKey(asPubRaw)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := devPriv.ECDH(asPub)
	if err != nil {
		t.Fatal(err)
	}
	prkKey, _ := hkdf.Extract(sha256.New, secret, auth)
	ikm, _ := hkdf.Expand(sha256.New, prkKey, "WebPush: info\x00"+string(devPriv.PublicKey().Bytes())+string(asPubRaw), 32)
	prk, _ := hkdf.Extract(sha256.New, ikm, salt)
	cek, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: aes128gcm\x00", 16)
	nonce, _ := hkdf.Expand(sha256.New, prk, "Content-Encoding: nonce\x00", 12)
	block, _ := aes.NewCipher(cek)
	gcm, _ := cipher.NewGCM(block)
	plain, err := gcm.Open(nil, nonce, ct, nil)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	plain = bytes.TrimRight(plain, "\x00")
	if len(plain) == 0 || plain[len(plain)-1] != 0x02 {
		t.Fatal("no last-record delimiter")
	}
	return plain[:len(plain)-1]
}

// testSender returns a Sender that trusts srv and sends to its URL, with the
// redirect policy of a production Sender. It also returns the signing key.
func testSender(t *testing.T, srv *httptest.Server) (*Sender, *ecdsa.PrivateKey) {
	t.Helper()
	p8, priv := newP8(t)
	k, err := ParseKey(p8, testKeyID, testTeamID)
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewSender(k, testTopic, Production, 5*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	hc := srv.Client()
	hc.CheckRedirect = s.hc.CheckRedirect
	s.hc = hc
	s.base = srv.URL
	return s, priv
}

// TestSend checks the request that Send makes and the way it maps each
// answer of the server to nil, ErrGone, or a StatusError.
func TestSend(t *testing.T) {
	var got *http.Request
	var body []byte
	status := http.StatusOK
	reply := ""
	srv := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		body, _ = io.ReadAll(r.Body)
		if status == http.StatusTooManyRequests {
			w.Header().Set("Retry-After", "30")
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, reply)
	}))
	srv.EnableHTTP2 = true
	srv.StartTLS()
	defer srv.Close()
	s, priv := testSender(t, srv)
	t0 := time.Unix(1_800_000_000, 0)
	s.now = func() time.Time { return t0 }
	dev, devPriv := newDevice(t)
	dev.Token = strings.ToUpper(testToken)
	ctx := context.Background()
	payload := []byte(`{"v":1,"kind":"message"}`)

	if err := s.Send(ctx, dev, payload, Options{TTL: 24 * time.Hour, CollapseID: "chalkmsg"}); err != nil {
		t.Fatal(err)
	}
	if got.Method != http.MethodPost || got.URL.Path != "/3/device/"+testToken {
		t.Fatalf("request = %s %s", got.Method, got.URL.Path)
	}
	if got.ProtoMajor != 2 {
		t.Fatalf("protocol = %s", got.Proto)
	}
	want := map[string]string{
		"apns-topic":       testTopic,
		"apns-push-type":   "alert",
		"apns-priority":    "10",
		"apns-expiration":  "1800086400",
		"apns-collapse-id": "chalkmsg",
		"Content-Type":     "application/json",
	}
	for h, v := range want {
		if got.Header.Get(h) != v {
			t.Fatalf("header %s = %q, want %q", h, got.Header.Get(h), v)
		}
	}
	if iss, iat := verifyToken(t, got.Header.Get("Authorization"), &priv.PublicKey); iss != testTeamID || iat != t0.Unix() {
		t.Fatalf("token claims: iss=%q iat=%d", iss, iat)
	}

	var n map[string]json.RawMessage
	if err := json.Unmarshal(body, &n); err != nil {
		t.Fatal(err)
	}
	if len(n) != 2 {
		t.Fatalf("body has the keys %v, want aps and chalk only", n)
	}
	var aps struct {
		Alert          struct{ Title, Body string }
		MutableContent int `json:"mutable-content"`
		Sound          string
	}
	if err := json.Unmarshal(n["aps"], &aps); err != nil {
		t.Fatal(err)
	}
	if aps.Alert.Title != FallbackTitle || aps.Alert.Body != FallbackBody || aps.MutableContent != 1 || aps.Sound != "default" {
		t.Fatalf("aps = %s", n["aps"])
	}
	if bytes.Contains(body, []byte("message")) {
		t.Fatal("the payload is in the body in clear text")
	}
	var sealedB64 string
	if err := json.Unmarshal(n["chalk"], &sealedB64); err != nil {
		t.Fatal(err)
	}
	sealed, err := base64.StdEncoding.DecodeString(sealedB64)
	if err != nil {
		t.Fatal(err)
	}
	if plain := open(t, sealed, devPriv, dev.Auth); !bytes.Equal(plain, payload) {
		t.Fatalf("sealed payload = %q", plain)
	}
	firstLen := len(body)

	if err := s.Send(ctx, dev, bytes.Repeat([]byte("x"), 900), Options{Priority: PriorityNormal}); err != nil {
		t.Fatal(err)
	}
	if len(body) != firstLen || len(body) >= 4096 {
		t.Fatalf("body is %d bytes, first was %d, limit is 4096", len(body), firstLen)
	}
	if got.Header.Get("apns-priority") != "5" || got.Header.Get("apns-expiration") != "0" {
		t.Fatalf("priority %q, expiration %q", got.Header.Get("apns-priority"), got.Header.Get("apns-expiration"))
	}
	if _, ok := got.Header["Apns-Collapse-Id"]; ok {
		t.Fatal("collapse id sent although it is empty")
	}

	gone := []struct {
		status int
		reply  string
	}{
		{http.StatusGone, `{"reason":"Unregistered","timestamp":1}`},
		{http.StatusGone, `{"reason":"ExpiredToken"}`},
		{http.StatusBadRequest, `{"reason":"BadDeviceToken"}`},
		{http.StatusBadRequest, `{"reason":"DeviceTokenNotForTopic"}`},
	}
	for _, tc := range gone {
		status, reply = tc.status, tc.reply
		err := s.Send(ctx, dev, payload, Options{})
		if !errors.Is(err, ErrGone) {
			t.Fatalf("%d %s: %v", tc.status, tc.reply, err)
		}
	}

	status, reply = http.StatusBadRequest, `{"reason":"BadTopic"}`
	var se *StatusError
	if err := s.Send(ctx, dev, payload, Options{}); !errors.As(err, &se) || se.Code != 400 || se.Reason != "BadTopic" || errors.Is(err, ErrGone) {
		t.Fatalf("BadTopic: %v", err)
	}

	status, reply = http.StatusTooManyRequests, `{"reason":"TooManyRequests"}`
	if err := s.Send(ctx, dev, payload, Options{}); !errors.As(err, &se) || se.Code != 429 || se.RetryAfter != "30" || se.Reason != "TooManyRequests" {
		t.Fatalf("429: %v", err)
	}
	if se.Error() != "apns: push service answered 429 (TooManyRequests)" {
		t.Fatalf("message = %q", se.Error())
	}

	status, reply = http.StatusServiceUnavailable, "first line\nsecond line"
	if err := s.Send(ctx, dev, payload, Options{}); !errors.As(err, &se) || strings.ContainsAny(se.Error(), "\r\n") {
		t.Fatalf("503: %v", err)
	}

	status, reply = http.StatusInternalServerError, ""
	if err := s.Send(ctx, dev, payload, Options{}); !errors.As(err, &se) || se.Code != 500 || se.Error() != "apns: push service answered 500" {
		t.Fatalf("500: %v", err)
	}

	status, reply = http.StatusOK, ""
	if err := s.Send(ctx, dev, payload, Options{}); err != nil {
		t.Fatal(err)
	}
	before := got.Header.Get("Authorization")
	status, reply = http.StatusForbidden, `{"reason":"ExpiredProviderToken"}`
	if err := s.Send(ctx, dev, payload, Options{}); !errors.As(err, &se) || se.Reason != "ExpiredProviderToken" {
		t.Fatalf("403: %v", err)
	}
	status, reply = http.StatusOK, ""
	if err := s.Send(ctx, dev, payload, Options{}); err != nil {
		t.Fatal(err)
	}
	if got.Header.Get("Authorization") == before {
		t.Fatal("the provider token was not renewed after ExpiredProviderToken")
	}

	got = nil
	bad := dev
	bad.Token = "../etc"
	if err := s.Send(ctx, bad, payload, Options{}); !errors.Is(err, ErrToken) || got != nil {
		t.Fatalf("bad token: %v, request sent: %v", err, got != nil)
	}
	if err := s.Send(ctx, dev, payload, Options{CollapseID: strings.Repeat("c", 65)}); !errors.Is(err, ErrCollapseID) || got != nil {
		t.Fatalf("long collapse id: %v", err)
	}
	short := dev
	short.Auth = dev.Auth[:8]
	if err := s.Send(ctx, short, payload, Options{}); err == nil || got != nil {
		t.Fatalf("short auth secret: %v", err)
	}
}

// TestSendRefusesNonPublicAddress uses the production client, which must not
// reach the loopback test server. It also checks NewSender.
func TestSendRefusesNonPublicAddress(t *testing.T) {
	p8, _ := newP8(t)
	k, err := ParseKey(p8, testKeyID, testTeamID)
	if err != nil {
		t.Fatal(err)
	}
	s, err := NewSender(k, testTopic, Sandbox, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if s.base != "https://api.sandbox.push.apple.com" || s.Topic() != testTopic {
		t.Fatalf("base %q, topic %q", s.base, s.Topic())
	}
	s.base = "https://127.0.0.1:1"
	dev, _ := newDevice(t)
	err = s.Send(context.Background(), dev, []byte("{}"), Options{})
	if err == nil || !strings.Contains(err.Error(), "not public") {
		t.Fatalf("loopback: %v", err)
	}
	if _, err := NewSender(k, "bad topic", Production, time.Second); err == nil {
		t.Fatal("want an error for a bad topic")
	}
}

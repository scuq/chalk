package webpush

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func mustB64(t *testing.T, s string) []byte {
	t.Helper()
	b, err := b64.DecodeString(s)
	if err != nil {
		t.Fatalf("base64url %q: %v", s, err)
	}
	return b
}

// TestEncryptRFC8291Vector reproduces Appendix A of RFC 8291 byte for byte.
func TestEncryptRFC8291Vector(t *testing.T) {
	plaintext := []byte("When I grow up, I want to be a watermelon")
	asPrivRaw := mustB64(t, "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")
	asPubWant := "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8"
	uaPub := mustB64(t, "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4")
	salt := mustB64(t, "DGv6ra1nlYgDCS1FRnbzlw")
	auth := mustB64(t, "BTBZMqHH6r4Tts7J_aSIgg")
	want := "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"

	asPriv, err := ecdh.P256().NewPrivateKey(asPrivRaw)
	if err != nil {
		t.Fatal(err)
	}
	if got := b64.EncodeToString(asPriv.PublicKey().Bytes()); got != asPubWant {
		t.Fatalf("sender public key = %s", got)
	}
	got, err := encrypt(plaintext, uaPub, auth, asPriv, salt, 0)
	if err != nil {
		t.Fatal(err)
	}
	if b64.EncodeToString(got) != want {
		t.Fatalf("message differs from the RFC vector:\n got %s\nwant %s", b64.EncodeToString(got), want)
	}
}

// decrypt is the receiver side of RFC 8291. It returns the payload without
// the delimiter and the padding.
func decrypt(t *testing.T, body []byte, uaPriv *ecdh.PrivateKey, auth []byte) []byte {
	t.Helper()
	salt := body[:16]
	if rs := binary.BigEndian.Uint32(body[16:20]); rs != recordSize {
		t.Fatalf("record size = %d", rs)
	}
	idLen := int(body[20])
	asPubRaw := body[21 : 21+idLen]
	ct := body[21+idLen:]
	asPub, err := ecdh.P256().NewPublicKey(asPubRaw)
	if err != nil {
		t.Fatal(err)
	}
	secret, err := uaPriv.ECDH(asPub)
	if err != nil {
		t.Fatal(err)
	}
	prkKey, _ := hkdf.Extract(sha256.New, secret, auth)
	ikm, _ := hkdf.Expand(sha256.New, prkKey, "WebPush: info\x00"+string(uaPriv.PublicKey().Bytes())+string(asPubRaw), 32)
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

func newUA(t *testing.T) (*ecdh.PrivateKey, []byte) {
	t.Helper()
	priv, err := ecdh.P256().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := make([]byte, 16)
	if _, err := rand.Read(auth); err != nil {
		t.Fatal(err)
	}
	return priv, auth
}

func TestEncryptHasOneLength(t *testing.T) {
	ua, auth := newUA(t)
	pub := ua.PublicKey().Bytes()
	var size int
	for _, n := range []int{0, 1, 40, 500, PaddedLen - 1} {
		payload := bytes.Repeat([]byte("x"), n)
		body, err := Encrypt(payload, pub, auth)
		if err != nil {
			t.Fatalf("payload of %d: %v", n, err)
		}
		if size == 0 {
			size = len(body)
		}
		if len(body) != size {
			t.Fatalf("payload of %d gives %d bytes, others give %d", n, len(body), size)
		}
		if got := decrypt(t, body, ua, auth); !bytes.Equal(got, payload) {
			t.Fatalf("payload of %d does not round-trip", n)
		}
	}
	if want := 16 + 4 + 1 + 65 + PaddedLen + 16; size != want {
		t.Fatalf("body is %d bytes, want %d", size, want)
	}
	if _, err := Encrypt(make([]byte, PaddedLen), pub, auth); !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("oversize payload: %v", err)
	}
	if _, err := Encrypt([]byte("x"), pub[:64], auth); err == nil {
		t.Fatal("short p256dh accepted")
	}
	if _, err := Encrypt([]byte("x"), pub, auth[:15]); err == nil {
		t.Fatal("short auth accepted")
	}
	// Two encryptions of one payload differ: fresh key and salt each time.
	a, _ := Encrypt([]byte("same"), pub, auth)
	b, _ := Encrypt([]byte("same"), pub, auth)
	if bytes.Equal(a, b) {
		t.Fatal("two encryptions are identical")
	}
}

func newKey(t *testing.T) *VAPIDKey {
	t.Helper()
	priv, pub, err := GenerateVAPIDKey()
	if err != nil {
		t.Fatal(err)
	}
	k, err := ParseVAPIDKey(priv, "https://chat.cyberdyne.example")
	if err != nil {
		t.Fatal(err)
	}
	if k.PublicKey() != pub {
		t.Fatal("parsed key has a different public key")
	}
	if raw := mustB64(t, pub); len(raw) != 65 || raw[0] != 4 {
		t.Fatalf("public key is not an uncompressed point (%d bytes)", len(raw))
	}
	return k
}

func TestVAPIDToken(t *testing.T) {
	k := newKey(t)
	now := time.Unix(1_800_000_000, 0)
	const aud = "https://push.cyberdyne.example"

	authz, err := k.authorization(aud, now)
	if err != nil {
		t.Fatal(err)
	}
	rest, ok := strings.CutPrefix(authz, "vapid t=")
	if !ok {
		t.Fatalf("header = %q", authz)
	}
	jwt, pub, ok := strings.Cut(rest, ", k=")
	if !ok || pub != k.PublicKey() {
		t.Fatalf("header = %q", authz)
	}
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		t.Fatalf("jwt has %d parts", len(parts))
	}
	if h := string(mustB64(t, parts[0])); h != `{"typ":"JWT","alg":"ES256"}` {
		t.Fatalf("header = %s", h)
	}
	var claims struct {
		Aud string `json:"aud"`
		Exp int64  `json:"exp"`
		Sub string `json:"sub"`
	}
	if err := json.Unmarshal(mustB64(t, parts[1]), &claims); err != nil {
		t.Fatal(err)
	}
	if claims.Aud != aud || claims.Sub != "https://chat.cyberdyne.example" || claims.Exp != now.Add(vapidTTL).Unix() {
		t.Fatalf("claims = %+v", claims)
	}
	sig := mustB64(t, parts[2])
	if len(sig) != 64 {
		t.Fatalf("signature is %d bytes", len(sig))
	}
	digest := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	pubRaw := mustB64(t, k.PublicKey())
	pk, err := ecdsa.ParseUncompressedPublicKey(elliptic.P256(), pubRaw)
	if err != nil {
		t.Fatal(err)
	}
	if !ecdsa.Verify(pk, digest[:], new(big.Int).SetBytes(sig[:32]), new(big.Int).SetBytes(sig[32:])) {
		t.Fatal("signature does not verify")
	}

	// The token is reused for the audience, not across audiences, and it is
	// replaced near its expiry.
	again, _ := k.authorization(aud, now.Add(time.Hour))
	if again != authz {
		t.Fatal("token was not reused")
	}
	other, _ := k.authorization("https://other.acme.example", now)
	if other == authz {
		t.Fatal("token was reused for another audience")
	}
	late, _ := k.authorization(aud, now.Add(vapidTTL-vapidRenew+time.Second))
	if late == authz {
		t.Fatal("token was not renewed near its expiry")
	}
}

func TestVAPIDKeyInput(t *testing.T) {
	priv, _, _ := GenerateVAPIDKey()
	for _, sub := range []string{"", "chat.cyberdyne.example", "http://chat.cyberdyne.example", "mailto:", "https://"} {
		if _, err := ParseVAPIDKey(priv, sub); err == nil {
			t.Fatalf("subject %q accepted", sub)
		}
	}
	if _, err := ParseVAPIDKey(priv, "mailto:admin@cyberdyne.example"); err != nil {
		t.Fatalf("mailto subject: %v", err)
	}
	if _, err := ParseVAPIDKey("AAAA", "https://chat.cyberdyne.example"); err == nil {
		t.Fatal("short private key accepted")
	}
	if _, err := ParseVAPIDKey("not base64!", "https://chat.cyberdyne.example"); err == nil {
		t.Fatal("bad base64 accepted")
	}
}

func TestValidateEndpoint(t *testing.T) {
	if origin, err := ValidateEndpoint("https://push.cyberdyne.example:8443/send/abc?x=1"); err != nil || origin != "https://push.cyberdyne.example:8443" {
		t.Fatalf("origin = %q, %v", origin, err)
	}
	for _, bad := range []string{"", "http://push.cyberdyne.example/a", "https:///a", "https://alice:pw@push.cyberdyne.example/a", "ftp://x/a", "::"} {
		if _, err := ValidateEndpoint(bad); !errors.Is(err, ErrEndpoint) {
			t.Fatalf("endpoint %q: %v", bad, err)
		}
	}
}

// testSender returns a Sender that trusts srv and can reach loopback, with
// the redirect policy of a production Sender.
func testSender(t *testing.T, srv *httptest.Server) *Sender {
	t.Helper()
	s := NewSender(newKey(t), 5*time.Second)
	hc := srv.Client()
	hc.CheckRedirect = s.hc.CheckRedirect
	s.hc = hc
	return s
}

func TestSend(t *testing.T) {
	ua, auth := newUA(t)
	var got *http.Request
	var body []byte
	status := http.StatusCreated
	reply := ""
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/redirect" {
			http.Redirect(w, r, "/elsewhere", http.StatusTemporaryRedirect)
			return
		}
		got = r
		body, _ = io.ReadAll(r.Body)
		if status == http.StatusTooManyRequests {
			w.Header().Set("Retry-After", "30")
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, reply)
	}))
	defer srv.Close()
	s := testSender(t, srv)
	sub := Subscription{Endpoint: srv.URL + "/send/abc", P256dh: ua.PublicKey().Bytes(), Auth: auth}
	opts := Options{TTL: 24 * time.Hour, Topic: "chalk", Urgency: UrgencyNormal}
	ctx := context.Background()

	if err := s.Send(ctx, sub, []byte(`{"v":1}`), opts); err != nil {
		t.Fatalf("send: %v", err)
	}
	if got.Method != http.MethodPost || got.URL.Path != "/send/abc" {
		t.Fatalf("request = %s %s", got.Method, got.URL.Path)
	}
	for name, want := range map[string]string{
		"Content-Encoding": "aes128gcm",
		"Content-Type":     "application/octet-stream",
		"TTL":              "86400",
		"Topic":            "chalk",
		"Urgency":          "normal",
	} {
		if h := got.Header.Get(name); h != want {
			t.Fatalf("%s = %q, want %q", name, h, want)
		}
	}
	if h := got.Header.Get("Authorization"); !strings.HasPrefix(h, "vapid t=") || !strings.HasSuffix(h, ", k="+s.PublicKey()) {
		t.Fatalf("Authorization = %q", h)
	}
	if plain := decrypt(t, body, ua, auth); string(plain) != `{"v":1}` {
		t.Fatalf("payload = %q", plain)
	}

	status = http.StatusGone
	if err := s.Send(ctx, sub, []byte("x"), opts); !errors.Is(err, ErrGone) {
		t.Fatalf("410: %v", err)
	}
	status = http.StatusNotFound
	if err := s.Send(ctx, sub, []byte("x"), opts); !errors.Is(err, ErrGone) {
		t.Fatalf("404: %v", err)
	}
	status = http.StatusTooManyRequests
	var se *StatusError
	if err := s.Send(ctx, sub, []byte("x"), opts); !errors.As(err, &se) || se.Code != 429 || se.RetryAfter != "30" {
		t.Fatalf("429: %v", err)
	}
	if se.Reason != "" || se.Error() != "webpush: push service answered 429" {
		t.Fatalf("429 without a body: reason %q, text %q", se.Reason, se.Error())
	}

	status = http.StatusBadRequest
	reply = `{"reason":"BadJwtToken"}`
	if err := s.Send(ctx, sub, []byte("x"), opts); !errors.As(err, &se) || se.Code != 400 || se.Reason != "BadJwtToken" {
		t.Fatalf("400: %v", err)
	}
	if se.Error() != "webpush: push service answered 400 (BadJwtToken)" {
		t.Fatalf("400 text: %q", se.Error())
	}
	status = http.StatusGone
	if err := s.Send(ctx, sub, []byte("x"), opts); !errors.Is(err, ErrGone) {
		t.Fatalf("410 with a body: %v", err)
	}
	reply = ""

	// A redirect is an answer, not an instruction: the sender does not
	// follow it.
	sub.Endpoint = srv.URL + "/redirect"
	if err := s.Send(ctx, sub, []byte("x"), opts); !errors.As(err, &se) || se.Code != http.StatusTemporaryRedirect {
		t.Fatalf("redirect: %v", err)
	}

	sub.Endpoint = strings.Replace(srv.URL, "https://", "http://", 1) + "/send/abc"
	if err := s.Send(ctx, sub, []byte("x"), opts); !errors.Is(err, ErrEndpoint) {
		t.Fatalf("http endpoint: %v", err)
	}
}

// TestSendRefusesNonPublicAddress uses the production client, which must
// not reach the loopback test server.
func TestSendRefusesNonPublicAddress(t *testing.T) {
	ua, auth := newUA(t)
	hit := false
	srv := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { hit = true }))
	defer srv.Close()
	s := NewSender(newKey(t), 5*time.Second)
	sub := Subscription{Endpoint: srv.URL + "/send", P256dh: ua.PublicKey().Bytes(), Auth: auth}
	err := s.Send(context.Background(), sub, []byte("x"), Options{})
	if !errors.Is(err, errDisallowedAddr) {
		t.Fatalf("loopback send: %v", err)
	}
	if hit {
		t.Fatal("the request reached the loopback server")
	}
}

func TestVetDialAddr(t *testing.T) {
	for _, bad := range []string{"10.0.0.1:443", "127.0.0.1:443", "169.254.169.254:80", "[::1]:443", "[fd00::1]:443", "100.64.0.1:443", "bogus", "[::ffff:10.0.0.1]:443"} {
		if err := vetDialAddr(bad); err == nil {
			t.Fatalf("%s accepted", bad)
		}
	}
	if err := vetDialAddr("93.184.216.34:443"); err != nil {
		t.Fatalf("public address refused: %v", err)
	}
}

// TestReasonFrom checks that reasonFrom takes the "reason" field of a JSON
// body, falls back to the body text, drops characters that are not printable
// ASCII, and cuts the result to maxReasonLen characters.
func TestReasonFrom(t *testing.T) {
	long := strings.Repeat("a", 300)
	for _, c := range []struct{ name, body, want string }{
		{"json reason", `{"reason":"VapidPkHashMismatch"}`, "VapidPkHashMismatch"},
		{"json reason with space", " {\"reason\": \"BadWebPushTopic\"}\n", "BadWebPushTopic"},
		{"json without reason", `{"error":"x"}`, `{"error":"x"}`},
		{"json reason not a string", `{"reason":7}`, `{"reason":7}`},
		{"plain text", "Bad Request\n", "Bad Request"},
		{"empty", "", ""},
		{"only space", " \r\n\t", ""},
		{"control characters", "a\r\nb\x00c\x1b[31md\x7f", "abc[31md"},
		{"json reason with a newline", `{"reason":"a\nb"}`, "ab"},
		{"non-ASCII", "café ☃ ok", "caf  ok"},
		{"bad UTF-8", "ok\xff\xfe", "ok"},
		{"long", long, long[:maxReasonLen]},
		{"long json reason", `{"reason":"` + long + `"}`, long[:maxReasonLen]},
	} {
		if got := reasonFrom([]byte(c.body)); got != c.want {
			t.Errorf("%s: reasonFrom = %q, want %q", c.name, got, c.want)
		}
	}
}

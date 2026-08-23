package integration

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"net/http"

	"github.com/coder/websocket"

	"github.com/scuq/chalk/internal/innerchan"
	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/server"
)

// 83-6: the inner sealed channel end to end against a real chalkd. A server
// configured WITH an identity key completes the handshake, and every frame
// after it -- hello, welcome, and beyond -- is sealed. Needs the DB
// (openStore skips without it, via startTestServerWithKey below).
func startTestServerWithKey(t *testing.T, key string) (string, func()) {
	t.Helper()
	st := openStore(t)
	priv, err := innerchan.ParseServerKey(key)
	if err != nil {
		t.Fatalf("parse key: %v", err)
	}
	wsCfg := server.DefaultWSConfig()
	wsCfg.ServerIDKey = priv
	srv, err := server.NewServer(server.Options{
		Listen: "127.0.0.1:0", Store: st, Hub: server.NewHub(), WSConfig: wsCfg,
	})
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); _ = srv.Serve(ctx) }()
	url := "http://" + srv.Addr().String()
	waitHealthz(t, url)
	select {
	case <-srv.PubsubReady():
	case <-time.After(5 * time.Second):
		cancel()
		t.Fatal("pubsub not ready")
	}
	return url, func() { cancel(); <-done }
}

func TestInnerSealedChannelEndToEnd(t *testing.T) {
	key, err := innerchan.GenerateServerKey()
	if err != nil {
		t.Fatal(err)
	}
	url, cleanup := startTestServerWithKey(t, key)
	defer cleanup()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	wsURL := strings.Replace(url, "http://", "ws://", 1) + "/ws"
	c, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{Subprotocols: []string{proto.Subprotocol}})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer c.Close(websocket.StatusNormalClosure, "")

	// inner_hello (plaintext)
	clientEph := mustEph(t)
	nonce := mustNonce(t)
	hello, _ := proto.NewFrame(proto.TypeInnerHello, "", proto.InnerHelloPayload{
		ProtoVersion: innerchan.ProtoVersion,
		ClientEphPub: base64.StdEncoding.EncodeToString(clientEph.pub),
		ClientNonce:  base64.StdEncoding.EncodeToString(nonce),
	})
	writeJSON(t, ctx, c, hello)

	// inner_ack (plaintext), verify + derive
	var ack proto.Frame
	readJSON(t, ctx, c, &ack)
	if ack.Type != proto.TypeInnerAck {
		t.Fatalf("want inner_ack, got %s", ack.Type)
	}
	var ap proto.InnerAckPayload
	if err := ack.DecodePayload(&ap); err != nil {
		t.Fatal(err)
	}
	serverEph, _ := base64.StdEncoding.DecodeString(ap.ServerEphPub)
	serverEd, _ := base64.StdEncoding.DecodeString(ap.ServerEd25519Pub)
	sig, _ := base64.StdEncoding.DecodeString(ap.Sig)
	th := innerchan.TranscriptHash(clientEph.pub, serverEph, nonce, serverEd)
	if !innerchan.VerifyServerSignature(serverEd, th, sig) {
		t.Fatal("server signature does not verify")
	}
	ss := ecdhShared(t, clientEph.priv, serverEph)
	sess, err := innerchan.DeriveSession(ss, th)
	if err != nil {
		t.Fatal(err)
	}

	// hello, sealed
	h, _ := proto.NewFrame(proto.TypeHello, "", proto.HelloPayload{DeviceID: "11111111-1111-4111-8111-111111111111"})
	hb, _ := json.Marshal(h)
	sealed, err := sess.SealFromClient(hb)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.Write(ctx, websocket.MessageBinary, sealed); err != nil {
		t.Fatal(err)
	}

	// welcome comes back sealed (binary)
	typ, data, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if typ != websocket.MessageBinary {
		t.Fatalf("welcome should be a sealed binary frame, got %v", typ)
	}
	pt, err := sess.OpenToClient(data)
	if err != nil {
		t.Fatalf("open welcome: %v", err)
	}
	var wf proto.Frame
	if err := json.Unmarshal(pt, &wf); err != nil {
		t.Fatal(err)
	}
	if wf.Type != proto.TypeWelcome {
		t.Fatalf("want welcome, got %s", wf.Type)
	}

	// a tampered outbound frame closes the connection (counter/auth violation)
	junk := make([]byte, 8+16)
	junk[7] = 2 // plausible counter, no valid ciphertext
	if err := c.Write(ctx, websocket.MessageBinary, junk); err != nil {
		t.Fatal(err)
	}
	if _, _, err := c.Read(ctx); err == nil {
		t.Fatal("server should have closed after an inner-channel violation")
	}
}

// GET /api/server-identity serves the pinnable key.
func TestServerIdentityEndpoint(t *testing.T) {
	key, _ := innerchan.GenerateServerKey()
	url, cleanup := startTestServerWithKey(t, key)
	defer cleanup()
	var body struct {
		Ed25519Pub  string `json:"ed25519_pub"`
		Fingerprint string `json:"fingerprint"`
	}
	getJSON(t, url+"/api/server-identity", &body)
	priv, _ := innerchan.ParseServerKey(key)
	wantPub := base64.StdEncoding.EncodeToString([]byte(priv.Public().(ed25519.PublicKey)))
	if body.Ed25519Pub != wantPub {
		t.Fatalf("served key %s, want %s", body.Ed25519Pub, wantPub)
	}
	if body.Ed25519Pub == "" || body.Fingerprint == "" {
		t.Fatalf("empty identity response: %+v", body)
	}
}

// ---- helpers scoped to the inner-channel test -------------------------

type ephPair struct {
	priv *ecdh.PrivateKey
	pub  []byte
}

func mustEph(t *testing.T) ephPair {
	t.Helper()
	k, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return ephPair{priv: k, pub: k.PublicKey().Bytes()}
}

func mustNonce(t *testing.T) []byte {
	t.Helper()
	n := make([]byte, 32)
	if _, err := rand.Read(n); err != nil {
		t.Fatal(err)
	}
	return n
}

func ecdhShared(t *testing.T, priv *ecdh.PrivateKey, peerPub []byte) []byte {
	t.Helper()
	peer, err := ecdh.X25519().NewPublicKey(peerPub)
	if err != nil {
		t.Fatal(err)
	}
	ss, err := priv.ECDH(peer)
	if err != nil {
		t.Fatal(err)
	}
	return ss
}

func waitHealthz(t *testing.T, url string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		resp, err := http.Get(url + "/healthz")
		if err == nil && resp.StatusCode == 200 {
			resp.Body.Close()
			return
		}
		if resp != nil {
			resp.Body.Close()
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("server /healthz never became reachable")
}

func writeJSON(t *testing.T, ctx context.Context, c *websocket.Conn, f proto.Frame) {
	t.Helper()
	b, _ := json.Marshal(f)
	if err := c.Write(ctx, websocket.MessageText, b); err != nil {
		t.Fatalf("write: %v", err)
	}
}

func readJSON(t *testing.T, ctx context.Context, c *websocket.Conn, out *proto.Frame) {
	t.Helper()
	_, data, err := c.Read(ctx)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if err := json.Unmarshal(data, out); err != nil {
		t.Fatalf("decode: %v", err)
	}
}

func getJSON(t *testing.T, url string, out any) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("GET %s: status %d", url, resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(out); err != nil {
		t.Fatalf("decode %s: %v", url, err)
	}
}

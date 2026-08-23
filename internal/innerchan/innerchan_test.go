package innerchan

import (
	"bytes"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"sort"
	"sync"
	"testing"
)

// playClient mirrors what the browser does with a server handshake result.
func playClient(t *testing.T, clientEph *ecdh.PrivateKey, clientNonce []byte, res *HandshakeResult) *Session {
	t.Helper()
	th := TranscriptHash(clientEph.PublicKey().Bytes(), res.ServerEphPub, clientNonce, res.ServerEdPub)
	if !VerifyServerSignature(res.ServerEdPub, th, res.Sig) {
		t.Fatal("server signature does not verify")
	}
	peer, err := ecdh.X25519().NewPublicKey(res.ServerEphPub)
	if err != nil {
		t.Fatal(err)
	}
	ss, err := clientEph.ECDH(peer)
	if err != nil {
		t.Fatal(err)
	}
	sess, err := DeriveSession(ss, th)
	if err != nil {
		t.Fatal(err)
	}
	return sess
}

func TestHandshakeAndSealedFrames(t *testing.T) {
	b64, err := GenerateServerKey()
	if err != nil {
		t.Fatal(err)
	}
	priv, err := ParseServerKey(b64)
	if err != nil {
		t.Fatal(err)
	}
	clientEph, _ := ecdh.X25519().GenerateKey(rand.Reader)
	nonce := make([]byte, 32)
	rand.Read(nonce)

	res, err := ServerHandshake(priv, clientEph.PublicKey().Bytes(), nonce)
	if err != nil {
		t.Fatal(err)
	}
	client := playClient(t, clientEph, nonce, res)
	server := res.Session

	// server -> client, in order
	for i, msg := range []string{"welcome", "message one", "message two"} {
		f, err := server.SealToClient([]byte(msg))
		if err != nil {
			t.Fatal(err)
		}
		pt, err := client.OpenToClient(f)
		if err != nil || string(pt) != msg {
			t.Fatalf("frame %d: %q %v", i, pt, err)
		}
		// replay of the same frame is refused
		if _, err := client.OpenToClient(f); !errors.Is(err, ErrCounter) {
			t.Fatalf("replay: want ErrCounter, got %v", err)
		}
	}
	// client -> server, independent counter
	f1, _ := client.SealFromClient([]byte("hello"))
	f2, _ := client.SealFromClient([]byte("send"))
	if _, err := server.OpenFromClient(f2); !errors.Is(err, ErrCounter) {
		t.Fatalf("out of order: want ErrCounter, got %v", err)
	}
	if pt, err := server.OpenFromClient(f1); err != nil || string(pt) != "hello" {
		t.Fatalf("f1: %q %v", pt, err)
	}
	if pt, err := server.OpenFromClient(f2); err != nil || string(pt) != "send" {
		t.Fatalf("f2: %q %v", pt, err)
	}
	// tampered ciphertext with a correct counter
	f3, _ := client.SealFromClient([]byte("tamper me"))
	f3[len(f3)-1] ^= 1
	if _, err := server.OpenFromClient(f3); !errors.Is(err, ErrOpen) {
		t.Fatalf("tamper: want ErrOpen, got %v", err)
	}
	// direction confusion: a client frame is not a server frame
	f4, _ := client.SealFromClient([]byte("wrong way"))
	other := playClient(t, clientEph, nonce, res) // fresh counters
	if _, err := other.OpenToClient(f4); err == nil {
		t.Fatal("a c2s frame must not open as s2c")
	}
}

func TestSignatureBindsEverything(t *testing.T) {
	b64, _ := GenerateServerKey()
	priv, _ := ParseServerKey(b64)
	clientEph, _ := ecdh.X25519().GenerateKey(rand.Reader)
	nonce := make([]byte, 32)
	rand.Read(nonce)
	res, err := ServerHandshake(priv, clientEph.PublicKey().Bytes(), nonce)
	if err != nil {
		t.Fatal(err)
	}
	good := TranscriptHash(clientEph.PublicKey().Bytes(), res.ServerEphPub, nonce, res.ServerEdPub)
	if !VerifyServerSignature(res.ServerEdPub, good, res.Sig) {
		t.Fatal("good transcript must verify")
	}
	// any field substituted -> the signature no longer verifies
	otherEph, _ := ecdh.X25519().GenerateKey(rand.Reader)
	otherNonce := make([]byte, 32)
	rand.Read(otherNonce)
	otherPub, _, _ := ed25519.GenerateKey(rand.Reader)
	for name, th := range map[string][32]byte{
		"client-eph": TranscriptHash(otherEph.PublicKey().Bytes(), res.ServerEphPub, nonce, res.ServerEdPub),
		"server-eph": TranscriptHash(clientEph.PublicKey().Bytes(), otherEph.PublicKey().Bytes(), nonce, res.ServerEdPub),
		"nonce":      TranscriptHash(clientEph.PublicKey().Bytes(), res.ServerEphPub, otherNonce, res.ServerEdPub),
		"server-key": TranscriptHash(clientEph.PublicKey().Bytes(), res.ServerEphPub, nonce, otherPub),
	} {
		if VerifyServerSignature(res.ServerEdPub, th, res.Sig) {
			t.Fatalf("%s substituted: must not verify", name)
		}
	}
	// a MITM with its own key cannot re-sign the transcript against the pin
	if VerifyServerSignature(otherPub, good, res.Sig) {
		t.Fatal("signature must not verify under another key")
	}
	// bad sizes
	if VerifyServerSignature(res.ServerEdPub, good, res.Sig[:63]) {
		t.Fatal("63-byte signature must not verify")
	}
	if _, err := ParseServerKey("not base64!"); !errors.Is(err, ErrBadServerKey) {
		t.Fatalf("bad key: %v", err)
	}
	if _, err := ServerHandshake(priv, clientEph.PublicKey().Bytes()[:31], nonce); !errors.Is(err, ErrBadLength) {
		t.Fatalf("short eph: %v", err)
	}
}

// TestKnownAnswer freezes the derivation so the browser implementation
// (web/src/crypto/innerchan.ts) can assert byte-identical output from the
// same fixed inputs. Fixed X25519 scalars and a fixed server seed; the
// expected values were produced by this test and are asserted by the TS
// suite -- two implementations agreeing, not one copying the other.
func TestKnownAnswer(t *testing.T) {
	curve := ecdh.X25519()
	clientEph, err := curve.NewPrivateKey(bytes.Repeat([]byte{0x11}, 32))
	if err != nil {
		t.Fatal(err)
	}
	serverEph, err := curve.NewPrivateKey(bytes.Repeat([]byte{0x22}, 32))
	if err != nil {
		t.Fatal(err)
	}
	priv := ed25519.NewKeyFromSeed(bytes.Repeat([]byte{0x33}, 32))
	nonce := bytes.Repeat([]byte{0x44}, 32)
	serverEdPub := priv.Public().(ed25519.PublicKey)
	th := TranscriptHash(clientEph.PublicKey().Bytes(), serverEph.PublicKey().Bytes(), nonce, serverEdPub)
	ss, err := clientEph.ECDH(serverEph.PublicKey())
	if err != nil {
		t.Fatal(err)
	}
	sess, err := DeriveSession(ss, th)
	if err != nil {
		t.Fatal(err)
	}
	frame, err := sess.SealToClient([]byte("known answer"))
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(priv, signedMessage(th))
	got := map[string]string{
		"transcript": hex.EncodeToString(th[:]),
		"frame":      hex.EncodeToString(frame),
		"sig":        hex.EncodeToString(sig),
	}
	want := map[string]string{
		"transcript": "5f33db1397e149e700d156a90fcc77da723e639da0b24023b863996b0effed20",
		"frame":      "0000000000000001a641c79613e5e8ea5dbcfde7486a901fd3daf5b943a36cce5aaa6d90",
		"sig":        "64f58b3b5cc056f6203a62400dc87b79a5c83e8c795b214bb5d8d330684b6dc42c65fdae068f5a06201f6520b1d5b81c71c8b7fdae810746881a6380dad0c30e",
	}
	for k, v := range want {
		if got[k] != v {
			t.Fatalf("KAT %s: got %s want %s", k, got[k], v)
		}
	}
	// The TS suite pins these; here we pin the structure that makes them
	// reproducible (counter 1, 8-byte prefix, 16-byte tag).
	if frame[7] != 1 || len(frame) != 8+len("known answer")+16 {
		t.Fatalf("frame shape: %x", frame)
	}
}

// Third audit: N goroutines sealing concurrently must mint frames that,
// ordered by their counters, all open -- the per-session mutex hands out
// counters exactly once each. (Ordering counter-to-WIRE is the writer
// mutex in ws.go's writeOne: seal+write are one critical section there.)
func TestConcurrentSealCountersAreDense(t *testing.T) {
	b64, _ := GenerateServerKey()
	priv, _ := ParseServerKey(b64)
	clientEph, _ := ecdh.X25519().GenerateKey(rand.Reader)
	nonce := make([]byte, 32)
	rand.Read(nonce)
	res, err := ServerHandshake(priv, clientEph.PublicKey().Bytes(), nonce)
	if err != nil {
		t.Fatal(err)
	}
	client := playClient(t, clientEph, nonce, res)

	const n = 64
	frames := make([][]byte, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			f, err := res.Session.SealToClient([]byte{byte(i)})
			if err != nil {
				t.Error(err)
				return
			}
			frames[i] = f
		}(i)
	}
	wg.Wait()
	sort.Slice(frames, func(a, b int) bool {
		return binary.BigEndian.Uint64(frames[a][:8]) < binary.BigEndian.Uint64(frames[b][:8])
	})
	for i, f := range frames {
		if got := binary.BigEndian.Uint64(f[:8]); got != uint64(i+1) {
			t.Fatalf("counters not dense: frame %d has counter %d", i, got)
		}
		if _, err := client.OpenToClient(f); err != nil {
			t.Fatalf("frame with counter %d failed to open: %v", i+1, err)
		}
	}
}

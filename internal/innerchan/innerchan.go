// Package innerchan is the 83-6 inner sealed channel: application-level
// channel binding over the WebSocket, so a client that has pinned its home
// server's identity can tell when someone else answers -- even with a valid
// TLS certificate in the path (CA mis-issuance, DNS takeover). Browsers
// cannot read TLS certificates or exporters, so the binding is built here
// rather than assumed.
//
// FROZEN CONSTRUCTION (PHASE-83-MSGSIG.md D.3):
//
//	client -> server : client_eph_pub(32) || client_nonce(32)      (plaintext)
//	server -> client : server_eph_pub(32) || server_ed25519_pub(32) || sig64
//	transcript_hash  = SHA-256(u8(proto_version = 1) || client_eph_pub
//	                    || server_eph_pub || client_nonce || server_ed25519_pub)
//	sig64            = Ed25519(server identity key,
//	                    utf8("chalk-server-id.v1") || transcript_hash)
//	ss               = X25519(client_eph, server_eph)
//	K_c2s            = HKDF-SHA256(ss, salt "chalk-inner-salt-v1",
//	                    info "chalk-inner-c2s-v1" || transcript_hash)
//	K_s2c            = HKDF-SHA256(ss, salt "chalk-inner-salt-v1",
//	                    info "chalk-inner-s2c-v1" || transcript_hash)
//
// Every subsequent frame is AES-256-GCM under the direction's key with an
// independent, strictly increasing 64-bit per-direction counter, encoded as
// the 96-bit nonce u32be(0) || u64be(counter) -- never implementation-chosen
// (R17's note). On the wire a sealed frame is u64be(counter) || ciphertext;
// a repeated or out-of-order counter is a protocol violation and the caller
// closes the connection.
//
// What this does not cover, stated plainly: a MITM that serves the SPA
// bundle itself (endpoint compromise), and theft of the server identity key
// (a lost trusted endpoint -- claim 2's R19 boundary). The key therefore
// lives only in chalkd's process, provisioned from CHALK_SERVER_ID_KEY.
package innerchan

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"sync"

	"golang.org/x/crypto/hkdf"
)

const (
	ProtoVersion = 1

	sigDomain  = "chalk-server-id.v1"
	hkdfSalt   = "chalk-inner-salt-v1"
	infoC2S    = "chalk-inner-c2s-v1"
	infoS2C    = "chalk-inner-s2c-v1"
	counterLen = 8
	nonceLen   = 12
)

var (
	ErrBadLength     = errors.New("innerchan: bad length")
	ErrCounter       = errors.New("innerchan: repeated or out-of-order counter")
	ErrOpen          = errors.New("innerchan: frame does not authenticate")
	ErrBadServerKey  = errors.New("innerchan: CHALK_SERVER_ID_KEY must be base64 of a 32-byte Ed25519 seed")
	ErrBadSignature  = errors.New("innerchan: server signature does not verify")
	ErrCounterExhaus = errors.New("innerchan: counter exhausted")
)

// ParseServerKey decodes CHALK_SERVER_ID_KEY (standard base64 of the 32-byte
// Ed25519 seed) into a private key.
func ParseServerKey(b64 string) (ed25519.PrivateKey, error) {
	seed, err := base64.StdEncoding.DecodeString(b64)
	if err != nil || len(seed) != ed25519.SeedSize {
		return nil, ErrBadServerKey
	}
	return ed25519.NewKeyFromSeed(seed), nil
}

// GenerateServerKey returns a fresh CHALK_SERVER_ID_KEY value (chalkctl init).
func GenerateServerKey() (string, error) {
	seed := make([]byte, ed25519.SeedSize)
	if _, err := io.ReadFull(rand.Reader, seed); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(seed), nil
}

// Fingerprint is the operator-facing rendering of a server public key: the
// hex SHA-256 of the raw 32 bytes, grouped in fours for reading aloud. What
// chalkctl prints and what the client's pin wall shows.
func Fingerprint(pub ed25519.PublicKey) string {
	h := sha256.Sum256(pub)
	s := fmt.Sprintf("%x", h[:16]) // 128 bits is plenty to compare by eye
	out := make([]byte, 0, len(s)+len(s)/4)
	for i := 0; i < len(s); i += 4 {
		if i > 0 {
			out = append(out, ' ')
		}
		out = append(out, s[i:i+4]...)
	}
	return string(out)
}

// TranscriptHash is the frozen binding of the handshake.
func TranscriptHash(clientEph, serverEph, clientNonce, serverEdPub []byte) [32]byte {
	h := sha256.New()
	h.Write([]byte{ProtoVersion})
	h.Write(clientEph)
	h.Write(serverEph)
	h.Write(clientNonce)
	h.Write(serverEdPub)
	var out [32]byte
	copy(out[:], h.Sum(nil))
	return out
}

func signedMessage(th [32]byte) []byte {
	return append([]byte(sigDomain), th[:]...)
}

// Session is one connection's sealed channel: two keys, two counters.
type Session struct {
	mu      sync.Mutex
	c2s     cipher.AEAD
	s2c     cipher.AEAD
	sendCtr uint64 // last counter we sent (server -> client)
	recvCtr uint64 // last counter we accepted (client -> server)
}

// HandshakeResult is what the server answers the client with.
type HandshakeResult struct {
	ServerEphPub []byte // 32
	ServerEdPub  []byte // 32
	Sig          []byte // 64
	Session      *Session
}

// ServerHandshake answers a client's (eph, nonce) and derives the session.
func ServerHandshake(priv ed25519.PrivateKey, clientEph, clientNonce []byte) (*HandshakeResult, error) {
	if len(clientEph) != 32 || len(clientNonce) != 32 || len(priv) != ed25519.PrivateKeySize {
		return nil, ErrBadLength
	}
	curve := ecdh.X25519()
	eph, err := curve.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	peer, err := curve.NewPublicKey(clientEph)
	if err != nil {
		return nil, fmt.Errorf("innerchan: client ephemeral: %w", err)
	}
	ss, err := eph.ECDH(peer)
	if err != nil {
		return nil, fmt.Errorf("innerchan: ecdh: %w", err)
	}
	serverEph := eph.PublicKey().Bytes()
	serverEdPub := priv.Public().(ed25519.PublicKey)
	th := TranscriptHash(clientEph, serverEph, clientNonce, serverEdPub)
	sig := ed25519.Sign(priv, signedMessage(th))
	sess, err := deriveSession(ss, th)
	if err != nil {
		return nil, err
	}
	return &HandshakeResult{ServerEphPub: serverEph, ServerEdPub: []byte(serverEdPub), Sig: sig, Session: sess}, nil
}

// VerifyServerSignature is the client-side check, exported so the Go tests
// can play the client and so any Go client (tests, tooling) shares one
// definition with the browser.
func VerifyServerSignature(serverEdPub []byte, th [32]byte, sig []byte) bool {
	if len(serverEdPub) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize {
		return false
	}
	return ed25519.Verify(ed25519.PublicKey(serverEdPub), signedMessage(th), sig)
}

// DeriveSession builds a session from the shared secret and transcript hash
// (exported for tests that play the client).
func DeriveSession(ss []byte, th [32]byte) (*Session, error) { return deriveSession(ss, th) }

func deriveSession(ss []byte, th [32]byte) (*Session, error) {
	mk := func(info string) (cipher.AEAD, error) {
		r := hkdf.New(sha256.New, ss, []byte(hkdfSalt), append([]byte(info), th[:]...))
		key := make([]byte, 32)
		if _, err := io.ReadFull(r, key); err != nil {
			return nil, err
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			return nil, err
		}
		return cipher.NewGCM(block)
	}
	c2s, err := mk(infoC2S)
	if err != nil {
		return nil, err
	}
	s2c, err := mk(infoS2C)
	if err != nil {
		return nil, err
	}
	return &Session{c2s: c2s, s2c: s2c}, nil
}

func nonceFor(counter uint64) []byte {
	n := make([]byte, nonceLen)
	binary.BigEndian.PutUint64(n[4:], counter)
	return n
}

// SealToClient seals one frame for the server -> client direction:
// u64be(counter) || AES-256-GCM(K_s2c, nonce, plaintext). Counters start at
// 1 and strictly increase.
func (s *Session) SealToClient(plaintext []byte) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sendCtr == ^uint64(0) {
		return nil, ErrCounterExhaus
	}
	s.sendCtr++
	out := make([]byte, counterLen, counterLen+len(plaintext)+s.s2c.Overhead())
	binary.BigEndian.PutUint64(out, s.sendCtr)
	return s.s2c.Seal(out, nonceFor(s.sendCtr), plaintext, nil), nil
}

// OpenFromClient opens one client -> server frame, enforcing the strictly
// increasing counter: the frame's counter must be exactly last+1. Any
// violation is ErrCounter and the caller MUST close the connection.
func (s *Session) OpenFromClient(frame []byte) ([]byte, error) {
	return s.open(frame, s.c2s, &s.recvCtr)
}

// SealFromClient / OpenToClient are the mirror pair, used by tests that
// play the client side in Go.
func (s *Session) SealFromClient(plaintext []byte) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.recvCtr++
	out := make([]byte, counterLen, counterLen+len(plaintext)+s.c2s.Overhead())
	binary.BigEndian.PutUint64(out, s.recvCtr)
	return s.c2s.Seal(out, nonceFor(s.recvCtr), plaintext, nil), nil
}

func (s *Session) OpenToClient(frame []byte) ([]byte, error) {
	return s.open(frame, s.s2c, &s.sendCtr)
}

func (s *Session) open(frame []byte, aead cipher.AEAD, last *uint64) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(frame) < counterLen+aead.Overhead() {
		return nil, ErrBadLength
	}
	ctr := binary.BigEndian.Uint64(frame[:counterLen])
	if ctr != *last+1 {
		return nil, ErrCounter
	}
	pt, err := aead.Open(nil, nonceFor(ctr), frame[counterLen:], nil)
	if err != nil {
		return nil, ErrOpen
	}
	*last = ctr
	return pt, nil
}

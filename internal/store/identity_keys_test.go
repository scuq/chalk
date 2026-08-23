package store

// 83-4: the identity-rotation primitive. Rotation is one transaction
// (retire the active generation, insert the next with its cert), refuses
// out-of-sequence generations and missing certs, and the chain listing
// returns every generation oldest-first with certs attached.
//
// Needs a live Postgres (openProbeDB): skips without CHALK_TEST_PGURL.

import (
	"bytes"
	"context"
	"errors"
	"testing"

	"github.com/google/uuid"
)

var rotUser = uuid.MustParse("22222222-3333-4444-5555-000000000001")

func key32(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }
func sig64(b byte) []byte { return bytes.Repeat([]byte{b}, 64) }

func TestRotateIdentityKey(t *testing.T) {
	pool := openProbeDB(t, "chalk_probe_idrotate")
	s := &Store{Pool: pool}
	ctx := context.Background()
	if _, err := pool.Exec(ctx,
		`INSERT INTO users (id, handle, username, display_name, email)
		    VALUES ($1,'rot_alice','rot_alice','Alice','rot_alice@x.test')`, rotUser); err != nil {
		t.Fatalf("seed user: %v", err)
	}

	// no identity yet: rotation has nothing to retire
	err := s.RotateIdentityKey(ctx, IdentityKey{UserID: rotUser, Generation: 2,
		X25519Pub: key32(2), Ed25519Pub: key32(3), SelfSig: sig64(4), GenCert: sig64(5)})
	if !errors.Is(err, ErrNotFound) {
		t.Fatalf("rotate without active: want ErrNotFound, got %v", err)
	}

	if err := s.PutIdentityKey(ctx, IdentityKey{UserID: rotUser, Generation: 1,
		X25519Pub: key32(0x10), Ed25519Pub: key32(0x11), SelfSig: sig64(0x12)}); err != nil {
		t.Fatalf("put gen 1: %v", err)
	}

	// skipping a number is refused
	err = s.RotateIdentityKey(ctx, IdentityKey{UserID: rotUser, Generation: 3,
		X25519Pub: key32(2), Ed25519Pub: key32(3), SelfSig: sig64(4), GenCert: sig64(5)})
	if !errors.Is(err, ErrRotationOutOfSequence) {
		t.Fatalf("skip: want ErrRotationOutOfSequence, got %v", err)
	}
	// a cert is mandatory
	if err := s.RotateIdentityKey(ctx, IdentityKey{UserID: rotUser, Generation: 2,
		X25519Pub: key32(2), Ed25519Pub: key32(3), SelfSig: sig64(4)}); err == nil {
		t.Fatalf("rotation without cert must fail")
	}

	// the real thing
	if err := s.RotateIdentityKey(ctx, IdentityKey{UserID: rotUser, Generation: 2,
		X25519Pub: key32(0x20), Ed25519Pub: key32(0x21), SelfSig: sig64(0x22), GenCert: sig64(0x23)}); err != nil {
		t.Fatalf("rotate: %v", err)
	}
	active, err := s.GetActiveIdentityKey(ctx, rotUser)
	if err != nil || active.Generation != 2 || !bytes.Equal(active.GenCert, sig64(0x23)) {
		t.Fatalf("active after rotate: gen=%d cert=%x err=%v", active.Generation, active.GenCert, err)
	}
	// re-rotating to 2 is out of sequence (the handler treats same-key as idempotent)
	if err := s.RotateIdentityKey(ctx, IdentityKey{UserID: rotUser, Generation: 2,
		X25519Pub: key32(0x20), Ed25519Pub: key32(0x21), SelfSig: sig64(0x22), GenCert: sig64(0x23)}); !errors.Is(err, ErrRotationOutOfSequence) {
		t.Fatalf("re-rotate: want ErrRotationOutOfSequence, got %v", err)
	}

	chain, err := s.ListIdentityKeys(ctx, rotUser)
	if err != nil || len(chain) != 2 {
		t.Fatalf("chain: len=%d err=%v", len(chain), err)
	}
	if chain[0].Generation != 1 || chain[0].GenCert != nil || !chain[0].IsRetired() {
		t.Fatalf("gen 1 should be a retired root without cert: %+v", chain[0])
	}
	if chain[1].Generation != 2 || chain[1].IsRetired() || !bytes.Equal(chain[1].Ed25519Pub, key32(0x21)) {
		t.Fatalf("gen 2 should be active with its key: %+v", chain[1])
	}
}

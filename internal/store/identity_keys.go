package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// IdentityKey is a user's public cryptographic identity for one
// generation. Per-user (not per-device): every device the user signs
// into derives the same keypair from their 24-word phrase, so the
// public halves stored here are shared across the user's devices.
//
// The server stores and relays these; it never verifies SelfSig. A
// client fetching another user's identity verifies
// Ed25519(Ed25519Pub, SelfSig) over X25519Pub itself, so a malicious
// server cannot substitute X25519Pub undetected. The Ed25519 key is
// pinned out-of-band by the phase-24 picture-word check.
//
// Generation supports phrase rotation (the decryption root is
// rotatable; see the crypto rebuild AMENDMENT). RetiredAt is zero for
// the active identity and set when a generation is rotated out.
type IdentityKey struct {
	UserID     uuid.UUID
	Generation int
	X25519Pub  []byte // 32 bytes
	Ed25519Pub []byte // 32 bytes
	SelfSig    []byte // 64 bytes, Ed25519 over X25519Pub
	CreatedAt  time.Time
	RetiredAt  time.Time // zero if active
}

// IsRetired reports whether this identity generation has been rotated out.
func (k IdentityKey) IsRetired() bool { return !k.RetiredAt.IsZero() }

// PutIdentityKey inserts a user's identity for the given generation. The
// caller supplies already-validated key material (lengths are also
// enforced by DB CHECK constraints). Used at first registration
// (generation 1) and, later, by rotation. Idempotent per
// (user_id, generation): re-publishing the same generation updates the
// stored material in place (a device re-deriving from the same phrase
// produces identical keys, so this is a safe no-op overwrite).
func (s *Store) PutIdentityKey(ctx context.Context, k IdentityKey) error {
	if len(k.X25519Pub) != 32 {
		return fmt.Errorf("PutIdentityKey: x25519_pub must be 32 bytes, got %d", len(k.X25519Pub))
	}
	if len(k.Ed25519Pub) != 32 {
		return fmt.Errorf("PutIdentityKey: ed25519_pub must be 32 bytes, got %d", len(k.Ed25519Pub))
	}
	if len(k.SelfSig) != 64 {
		return fmt.Errorf("PutIdentityKey: self_sig must be 64 bytes, got %d", len(k.SelfSig))
	}
	gen := k.Generation
	if gen < 1 {
		gen = 1
	}
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO identity_keys
		   (user_id, generation, x25519_pub, ed25519_pub, self_sig, created_at)
		 VALUES ($1, $2, $3, $4, $5, now())
		 ON CONFLICT (user_id, generation) DO UPDATE
		   SET x25519_pub  = EXCLUDED.x25519_pub,
		       ed25519_pub = EXCLUDED.ed25519_pub,
		       self_sig    = EXCLUDED.self_sig`,
		k.UserID, gen, k.X25519Pub, k.Ed25519Pub, k.SelfSig,
	)
	if err != nil {
		return fmt.Errorf("put identity key: %w", err)
	}
	return nil
}

// GetActiveIdentityKey returns the user's current (non-retired) identity.
// Returns ErrNotFound if the user has not published one yet. The
// one-active-per-user partial unique index guarantees at most one row.
func (s *Store) GetActiveIdentityKey(ctx context.Context, userID uuid.UUID) (IdentityKey, error) {
	var k IdentityKey
	var retiredAt *time.Time
	err := s.Pool.QueryRow(ctx,
		`SELECT user_id, generation, x25519_pub, ed25519_pub, self_sig, created_at, retired_at
		   FROM identity_keys
		  WHERE user_id = $1 AND retired_at IS NULL`,
		userID,
	).Scan(&k.UserID, &k.Generation, &k.X25519Pub, &k.Ed25519Pub, &k.SelfSig, &k.CreatedAt, &retiredAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return IdentityKey{}, ErrNotFound
	}
	if err != nil {
		return IdentityKey{}, fmt.Errorf("get active identity key: %w", err)
	}
	if retiredAt != nil {
		k.RetiredAt = *retiredAt
	}
	return k, nil
}

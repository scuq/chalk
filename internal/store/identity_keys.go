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
	// GenCert (83-4) is the chalk-idgen.v1 cert: 64 bytes, Ed25519 by
	// generation N-1's key admitting this generation. Nil for generation 1
	// (a chain root) and for a generation that starts a new chain after key
	// loss. Stored and relayed, never verified here.
	GenCert   []byte
	CreatedAt time.Time
	RetiredAt time.Time // zero if active
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
		`SELECT user_id, generation, x25519_pub, ed25519_pub, self_sig, gen_cert, created_at, retired_at
		   FROM identity_keys
		  WHERE user_id = $1 AND retired_at IS NULL`,
		userID,
	).Scan(&k.UserID, &k.Generation, &k.X25519Pub, &k.Ed25519Pub, &k.SelfSig, &k.GenCert, &k.CreatedAt, &retiredAt)
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

// GetActiveIdentityKeyAny is GetActiveIdentityKey with an ephemeral-guest
// fallback (80-9): a real member verifying a GUEST's DTLS fingerprint needs
// the guest's keys, which live in ephemeral_identity_keys. Guests never
// rotate, so the fallback reports generation 1.
func (s *Store) GetActiveIdentityKeyAny(ctx context.Context, userID uuid.UUID) (IdentityKey, error) {
	k, err := s.GetActiveIdentityKey(ctx, userID)
	if !errors.Is(err, ErrNotFound) {
		return k, err
	}
	err = s.Pool.QueryRow(ctx,
		`SELECT user_id, x25519_pub, ed25519_pub, self_sig, created_at
		   FROM ephemeral_identity_keys WHERE user_id = $1`,
		userID,
	).Scan(&k.UserID, &k.X25519Pub, &k.Ed25519Pub, &k.SelfSig, &k.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return IdentityKey{}, ErrNotFound
	}
	if err != nil {
		return IdentityKey{}, fmt.Errorf("get ephemeral identity key: %w", err)
	}
	k.Generation = 1
	return k, nil
}

// ErrRotationOutOfSequence is returned by RotateIdentityKey when the new
// generation is not exactly the active generation plus one.
var ErrRotationOutOfSequence = errors.New("identity rotation out of sequence")

// RotateIdentityKey retires the caller's active identity and inserts the
// next generation, in ONE transaction (83-4). Requirements, all enforced
// here: k.Generation >= 2; k.GenCert is exactly 64 bytes (the server cannot
// verify it, but a rotation without a cert is not a rotation -- a chain
// root after key loss goes through the recovery path, not here); and the
// currently active generation is exactly k.Generation-1, so two devices
// racing a rotation cannot both succeed and cannot skip a number. The row
// lock on the active generation serializes concurrent rotations.
func (s *Store) RotateIdentityKey(ctx context.Context, k IdentityKey) error {
	if k.Generation < 2 {
		return fmt.Errorf("RotateIdentityKey: generation must be >= 2, got %d", k.Generation)
	}
	if len(k.GenCert) != 64 {
		return fmt.Errorf("RotateIdentityKey: gen_cert must be 64 bytes, got %d", len(k.GenCert))
	}
	if len(k.X25519Pub) != 32 || len(k.Ed25519Pub) != 32 || len(k.SelfSig) != 64 {
		return errors.New("RotateIdentityKey: malformed key material")
	}
	return s.withTx(ctx, func(tx pgx.Tx) error {
		var active int
		err := tx.QueryRow(ctx,
			`SELECT generation FROM identity_keys
			  WHERE user_id = $1 AND retired_at IS NULL
			  FOR UPDATE`,
			k.UserID,
		).Scan(&active)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("lock active identity: %w", err)
		}
		if active != k.Generation-1 {
			return ErrRotationOutOfSequence
		}
		if _, err := tx.Exec(ctx,
			`UPDATE identity_keys SET retired_at = now()
			  WHERE user_id = $1 AND generation = $2`,
			k.UserID, active,
		); err != nil {
			return fmt.Errorf("retire identity: %w", err)
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO identity_keys
			   (user_id, generation, x25519_pub, ed25519_pub, self_sig, gen_cert, created_at)
			 VALUES ($1, $2, $3, $4, $5, $6, now())`,
			k.UserID, k.Generation, k.X25519Pub, k.Ed25519Pub, k.SelfSig, k.GenCert,
		); err != nil {
			return fmt.Errorf("insert identity generation: %w", err)
		}
		return nil
	})
}

// ListIdentityKeys returns every generation of a user's identity, retired
// ones included, oldest first -- the chain a client walks (83-4). Empty when
// the user has published nothing.
func (s *Store) ListIdentityKeys(ctx context.Context, userID uuid.UUID) ([]IdentityKey, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT user_id, generation, x25519_pub, ed25519_pub, self_sig, gen_cert, created_at, retired_at
		   FROM identity_keys
		  WHERE user_id = $1
		  ORDER BY generation ASC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("list identity keys: %w", err)
	}
	defer rows.Close()
	out := []IdentityKey{}
	for rows.Next() {
		var k IdentityKey
		var retiredAt *time.Time
		if err := rows.Scan(&k.UserID, &k.Generation, &k.X25519Pub, &k.Ed25519Pub, &k.SelfSig, &k.GenCert, &k.CreatedAt, &retiredAt); err != nil {
			return nil, err
		}
		if retiredAt != nil {
			k.RetiredAt = *retiredAt
		}
		out = append(out, k)
	}
	return out, rows.Err()
}

// chalk -- phase31-slice31-1 auth_v2 data layer.
//
// Data layer for auth v2 (password + mandatory TOTP), the password/passkey-
// wrapped identity entropy that lets a new device unlock keys without
// re-typing the 24-word phrase, and one-time backup codes. See
// docs/phase-31/ for the design; migration 0040_auth_v2.sql for the schema.
//
// The server is a blind relay for key material: identity_seed_wrap blobs are
// OPAQUE (client-encrypted), and this layer never interprets them. TOTP
// secrets are server-symmetric-encrypted by the caller (Addendum A); this
// layer stores the ciphertext as an opaque BYTEA.
//
// HTTP handlers, Argon2id verification, TOTP validation, and crypto live in
// later slices (31-2 .. 31-4, 31-8, 31-9); this file is storage only.
package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// UserAuth is the per-user password + TOTP row (one per user).
//
// Nullable columns map to Go zero values: TOTPSecretEnc is nil until a secret
// is set; TOTPConfirmedAt and LockedUntil are zero until confirmed/locked.
type UserAuth struct {
	UserID          uuid.UUID
	AuthProofHash   []byte
	AuthSalt        []byte
	KDFAlg          int16
	KDFMemKiB       int32
	KDFIters        int32
	KDFPar          int32
	TOTPSecretEnc   []byte
	TOTPConfirmedAt time.Time
	TOTPLastStep    int64
	FailedTOTPCount int32
	LockedUntil     time.Time
	AuthV2Enrolled  bool
	CreatedAt       time.Time
	UpdatedAt       time.Time
}

// TOTPConfirmed reports whether the user has an activated TOTP secret.
func (a UserAuth) TOTPConfirmed() bool { return !a.TOTPConfirmedAt.IsZero() }

// IsLocked reports whether TOTP verification is currently locked out.
func (a UserAuth) IsLocked(now time.Time) bool {
	return !a.LockedUntil.IsZero() && a.LockedUntil.After(now)
}

// IdentitySeedWrap is the BIP-39 entropy wrapped under one unlock method.
// Method is "password" (CredentialID empty) or "passkey" (CredentialID is the
// WebAuthn credential id). WrapSuite/WrapBlob are opaque, client-defined.
type IdentitySeedWrap struct {
	UserID       uuid.UUID
	Method       string
	CredentialID []byte
	Generation   int
	WrapSuite    int16
	WrapBlob     []byte
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// BackupCode is a single one-time TOTP fallback, stored only as a hash.
type BackupCode struct {
	UserID    uuid.UUID
	CodeHash  []byte
	UsedAt    time.Time // zero if unused
	CreatedAt time.Time
}

// ErrBackupCodeAlreadyUsed is returned by ConsumeBackupCode when the code
// exists but was already redeemed.
var ErrBackupCodeAlreadyUsed = errors.New("backup code already used")

// GetUserAuth fetches the auth row for userID. Returns ErrNotFound if the
// user has not enrolled a password yet.
func (s *Store) GetUserAuth(ctx context.Context, userID uuid.UUID) (UserAuth, error) {
	var a UserAuth
	var (
		secret    []byte
		confirmed *time.Time
		locked    *time.Time
	)
	err := s.Pool.QueryRow(ctx,
		`SELECT user_id, auth_proof_hash, auth_salt, kdf_alg, kdf_mem_kib,
		        kdf_iters, kdf_par, totp_secret_enc, totp_confirmed_at,
		        totp_last_step, failed_totp_count, locked_until,
		        auth_v2_enrolled, created_at, updated_at
		   FROM user_auth WHERE user_id = $1`,
		userID,
	).Scan(
		&a.UserID, &a.AuthProofHash, &a.AuthSalt, &a.KDFAlg, &a.KDFMemKiB,
		&a.KDFIters, &a.KDFPar, &secret, &confirmed,
		&a.TOTPLastStep, &a.FailedTOTPCount, &locked,
		&a.AuthV2Enrolled, &a.CreatedAt, &a.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return UserAuth{}, ErrNotFound
	}
	if err != nil {
		return UserAuth{}, fmt.Errorf("get user_auth: %w", err)
	}
	a.TOTPSecretEnc = secret
	if confirmed != nil {
		a.TOTPConfirmedAt = *confirmed
	}
	if locked != nil {
		a.LockedUntil = *locked
	}
	return a, nil
}

// UpsertPasswordAuth writes the password half of the auth row: the authProof
// hash, salt, and the client's Argon2id parameters. Used at signup and at
// change-password. On conflict it updates only the password columns, leaving
// the TOTP and enrollment state intact.
func (s *Store) UpsertPasswordAuth(
	ctx context.Context,
	userID uuid.UUID,
	authProofHash, authSalt []byte,
	kdfAlg int16,
	kdfMemKiB, kdfIters, kdfPar int32,
) error {
	if len(authProofHash) == 0 || len(authSalt) == 0 {
		return fmt.Errorf("UpsertPasswordAuth: proof and salt required")
	}
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO user_auth
		     (user_id, auth_proof_hash, auth_salt, kdf_alg, kdf_mem_kib,
		      kdf_iters, kdf_par)
		   VALUES ($1, $2, $3, $4, $5, $6, $7)
		   ON CONFLICT (user_id) DO UPDATE
		     SET auth_proof_hash = EXCLUDED.auth_proof_hash,
		         auth_salt       = EXCLUDED.auth_salt,
		         kdf_alg         = EXCLUDED.kdf_alg,
		         kdf_mem_kib     = EXCLUDED.kdf_mem_kib,
		         kdf_iters       = EXCLUDED.kdf_iters,
		         kdf_par         = EXCLUDED.kdf_par,
		         updated_at      = now()`,
		userID, authProofHash, authSalt, kdfAlg, kdfMemKiB, kdfIters, kdfPar,
	)
	if err != nil {
		return fmt.Errorf("upsert password auth: %w", err)
	}
	return nil
}

// SetTOTPSecret stores an (encrypted) TOTP secret and clears any prior
// confirmation, so the secret is inactive until ConfirmTOTP succeeds. The
// row must already exist (password enrolled first); returns ErrNotFound
// otherwise.
func (s *Store) SetTOTPSecret(ctx context.Context, userID uuid.UUID, secretEnc []byte) error {
	if len(secretEnc) == 0 {
		return fmt.Errorf("SetTOTPSecret: secret required")
	}
	tag, err := s.Pool.Exec(ctx,
		`UPDATE user_auth
		    SET totp_secret_enc   = $2,
		        totp_confirmed_at = NULL,
		        totp_last_step    = 0,
		        failed_totp_count = 0,
		        updated_at        = now()
		  WHERE user_id = $1`,
		userID, secretEnc,
	)
	if err != nil {
		return fmt.Errorf("set totp secret: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ConfirmTOTP marks the stored TOTP secret as active. It requires a secret to
// be present; returns ErrNotFound if no row or no secret is set.
func (s *Store) ConfirmTOTP(ctx context.Context, userID uuid.UUID) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE user_auth
		    SET totp_confirmed_at = now(),
		        failed_totp_count = 0,
		        updated_at        = now()
		  WHERE user_id = $1 AND totp_secret_enc IS NOT NULL`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("confirm totp: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// SetAuthV2Enrolled flips the hard-cutover enrollment flag.
func (s *Store) SetAuthV2Enrolled(ctx context.Context, userID uuid.UUID, enrolled bool) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE user_auth
		    SET auth_v2_enrolled = $2,
		        updated_at       = now()
		  WHERE user_id = $1`,
		userID, enrolled,
	)
	if err != nil {
		return fmt.Errorf("set auth_v2_enrolled: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// PutIdentitySeedWrap upserts one wrapped-entropy row keyed by
// (user, method, credential_id, generation). CredentialID must be empty for
// method "password" and non-empty for method "passkey" (also enforced by a
// DB CHECK).
func (s *Store) PutIdentitySeedWrap(ctx context.Context, w IdentitySeedWrap) error {
	if w.Method != "password" && w.Method != "passkey" {
		return fmt.Errorf("PutIdentitySeedWrap: invalid method %q", w.Method)
	}
	if len(w.WrapBlob) == 0 {
		return fmt.Errorf("PutIdentitySeedWrap: wrap_blob required")
	}
	if w.Generation < 1 {
		w.Generation = 1
	}
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO identity_seed_wrap
		     (user_id, method, credential_id, generation, wrap_suite, wrap_blob)
		   VALUES ($1, $2, $3, $4, $5, $6)
		   ON CONFLICT (user_id, method, credential_id, generation) DO UPDATE
		     SET wrap_suite = EXCLUDED.wrap_suite,
		         wrap_blob  = EXCLUDED.wrap_blob,
		         updated_at = now()`,
		w.UserID, w.Method, w.CredentialID, w.Generation, w.WrapSuite, w.WrapBlob,
	)
	if err != nil {
		return fmt.Errorf("put identity seed wrap: %w", err)
	}
	return nil
}

// ListIdentitySeedWraps returns all wrapped-entropy rows for a user at one
// generation, ordered by method then credential. Used by new-device unlock to
// find a usable wrap.
func (s *Store) ListIdentitySeedWraps(ctx context.Context, userID uuid.UUID, generation int) ([]IdentitySeedWrap, error) {
	if generation < 1 {
		generation = 1
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT user_id, method, credential_id, generation, wrap_suite,
		        wrap_blob, created_at, updated_at
		   FROM identity_seed_wrap
		  WHERE user_id = $1 AND generation = $2
		  ORDER BY method, credential_id`,
		userID, generation,
	)
	if err != nil {
		return nil, fmt.Errorf("list identity seed wraps: %w", err)
	}
	defer rows.Close()

	var out []IdentitySeedWrap
	for rows.Next() {
		var w IdentitySeedWrap
		if err := rows.Scan(
			&w.UserID, &w.Method, &w.CredentialID, &w.Generation, &w.WrapSuite,
			&w.WrapBlob, &w.CreatedAt, &w.UpdatedAt,
		); err != nil {
			return nil, fmt.Errorf("scan identity seed wrap: %w", err)
		}
		out = append(out, w)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate identity seed wraps: %w", err)
	}
	return out, nil
}

// DeleteIdentitySeedWrap removes one wrap (e.g. when a passkey is removed).
// Returns ErrNotFound if no matching row existed.
func (s *Store) DeleteIdentitySeedWrap(
	ctx context.Context,
	userID uuid.UUID,
	method string,
	credentialID []byte,
	generation int,
) error {
	if generation < 1 {
		generation = 1
	}
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM identity_seed_wrap
		  WHERE user_id = $1 AND method = $2
		    AND credential_id = $3 AND generation = $4`,
		userID, method, credentialID, generation,
	)
	if err != nil {
		return fmt.Errorf("delete identity seed wrap: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// ReplaceBackupCodes atomically deletes all of a user's existing backup codes
// and inserts the supplied hashes. Used at enrollment and at regeneration.
// Passing an empty slice clears the user's codes.
func (s *Store) ReplaceBackupCodes(ctx context.Context, userID uuid.UUID, hashes [][]byte) error {
	for i, h := range hashes {
		if len(h) == 0 {
			return fmt.Errorf("ReplaceBackupCodes: empty hash at index %d", i)
		}
	}
	return s.withTx(ctx, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`DELETE FROM auth_backup_code WHERE user_id = $1`, userID,
		); err != nil {
			return fmt.Errorf("clear backup codes: %w", err)
		}
		for _, h := range hashes {
			if _, err := tx.Exec(ctx,
				`INSERT INTO auth_backup_code (user_id, code_hash)
				   VALUES ($1, $2)`,
				userID, h,
			); err != nil {
				return fmt.Errorf("insert backup code: %w", err)
			}
		}
		return nil
	})
}

// ConsumeBackupCode marks a matching unused code as used. Returns ErrNotFound
// if no such code exists for the user, or ErrBackupCodeAlreadyUsed if it
// exists but was already redeemed.
func (s *Store) ConsumeBackupCode(ctx context.Context, userID uuid.UUID, codeHash []byte) error {
	if len(codeHash) == 0 {
		return fmt.Errorf("ConsumeBackupCode: hash required")
	}
	tag, err := s.Pool.Exec(ctx,
		`UPDATE auth_backup_code
		    SET used_at = now()
		  WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
		userID, codeHash,
	)
	if err != nil {
		return fmt.Errorf("consume backup code: %w", err)
	}
	if tag.RowsAffected() == 0 {
		var exists bool
		if err := s.Pool.QueryRow(ctx,
			`SELECT EXISTS (
			   SELECT 1 FROM auth_backup_code
			    WHERE user_id = $1 AND code_hash = $2)`,
			userID, codeHash,
		).Scan(&exists); err != nil {
			return fmt.Errorf("post-consume check: %w", err)
		}
		if exists {
			return ErrBackupCodeAlreadyUsed
		}
		return ErrNotFound
	}
	return nil
}

// CountUnusedBackupCodes returns how many one-time codes remain for a user.
func (s *Store) CountUnusedBackupCodes(ctx context.Context, userID uuid.UUID) (int, error) {
	var n int
	if err := s.Pool.QueryRow(ctx,
		`SELECT count(*) FROM auth_backup_code
		  WHERE user_id = $1 AND used_at IS NULL`,
		userID,
	).Scan(&n); err != nil {
		return 0, fmt.Errorf("count unused backup codes: %w", err)
	}
	return n, nil
}

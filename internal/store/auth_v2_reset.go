// chalk -- phase31-slice31-4 auth reset data layer.
//
// TOTP-reset staging (migration 0041) and the two password-reset paths:
// change-password (knows current) and recovery-gated reset (lost password).
// All multi-column mutations run under withTx; the recovery reset also
// deletes the now-stale password seed wraps (they were wrapped under the OLD
// password's KEK and can never be opened again -- the client re-creates the
// wrap from the ENCRYPTION phrase after logging in).
package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// SetPendingTOTPSecret stages a new (encrypted) TOTP secret WITHOUT touching
// the active one, so the active secret keeps working until the pending one is
// confirmed. Requires the user_auth row to exist (password enrolled first);
// returns ErrNotFound otherwise.
func (s *Store) SetPendingTOTPSecret(ctx context.Context, userID uuid.UUID, secretEnc []byte) error {
	if len(secretEnc) == 0 {
		return fmt.Errorf("SetPendingTOTPSecret: secret required")
	}
	tag, err := s.Pool.Exec(ctx,
		`UPDATE user_auth
		    SET totp_pending_secret_enc = $2, updated_at = now()
		  WHERE user_id = $1`,
		userID, secretEnc,
	)
	if err != nil {
		return fmt.Errorf("set pending totp secret: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

// GetPendingTOTPSecret returns the staged secret blob, or ErrNotFound when the
// row does not exist or nothing is staged.
func (s *Store) GetPendingTOTPSecret(ctx context.Context, userID uuid.UUID) ([]byte, error) {
	var enc []byte
	err := s.Pool.QueryRow(ctx,
		`SELECT totp_pending_secret_enc FROM user_auth WHERE user_id = $1`,
		userID,
	).Scan(&enc)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get pending totp secret: %w", err)
	}
	if len(enc) == 0 {
		return nil, ErrNotFound
	}
	return enc, nil
}

// PromotePendingTOTP atomically promotes the staged secret to active: the
// active secret is replaced, confirmation is stamped, replay/lockout counters
// reset, and the staging column cleared. Returns ErrNotFound when nothing is
// staged. Run under FOR UPDATE so a concurrent login attempt cannot interleave
// with the swap.
func (s *Store) PromotePendingTOTP(ctx context.Context, userID uuid.UUID) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		var pending []byte
		err := tx.QueryRow(ctx,
			`SELECT totp_pending_secret_enc FROM user_auth
			  WHERE user_id = $1 FOR UPDATE`,
			userID,
		).Scan(&pending)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("select pending totp for update: %w", err)
		}
		if len(pending) == 0 {
			return ErrNotFound
		}
		if _, err := tx.Exec(ctx,
			`UPDATE user_auth
			    SET totp_secret_enc         = totp_pending_secret_enc,
			        totp_pending_secret_enc = NULL,
			        totp_confirmed_at       = now(),
			        totp_last_step          = 0,
			        failed_totp_count       = 0,
			        locked_until            = NULL,
			        updated_at              = now()
			  WHERE user_id = $1`,
			userID,
		); err != nil {
			return fmt.Errorf("promote pending totp: %w", err)
		}
		return nil
	})
}

// ChangePasswordAuth atomically installs a new password (proof hash, salt,
// KDF params) and replaces the password-method identity seed wrap with one
// the client re-sealed under the NEW password's KEK. The caller has already
// verified the CURRENT password. Generation tags the wrap row.
func (s *Store) ChangePasswordAuth(
	ctx context.Context,
	userID uuid.UUID,
	proofHash, salt []byte,
	alg int16,
	memKiB, iters, par int32,
	generation int,
	wrapSuite int16,
	wrapBlob []byte,
) error {
	if len(proofHash) == 0 || len(salt) == 0 {
		return fmt.Errorf("ChangePasswordAuth: proof and salt required")
	}
	if len(wrapBlob) == 0 {
		return fmt.Errorf("ChangePasswordAuth: wrap_blob required")
	}
	if generation < 1 {
		generation = 1
	}
	return s.withTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx,
			`UPDATE user_auth
			    SET auth_proof_hash = $2, auth_salt = $3, kdf_alg = $4,
			        kdf_mem_kib = $5, kdf_iters = $6, kdf_par = $7,
			        updated_at = now()
			  WHERE user_id = $1`,
			userID, proofHash, salt, alg, memKiB, iters, par,
		)
		if err != nil {
			return fmt.Errorf("update password auth: %w", err)
		}
		if tag.RowsAffected() == 0 {
			return ErrNotFound
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO identity_seed_wrap
			     (user_id, method, credential_id, generation, wrap_suite, wrap_blob)
			   VALUES ($1, 'password', '\x'::bytea, $2, $3, $4)
			   ON CONFLICT (user_id, method, credential_id, generation) DO UPDATE
			     SET wrap_suite = EXCLUDED.wrap_suite,
			         wrap_blob  = EXCLUDED.wrap_blob,
			         updated_at = now()`,
			userID, generation, wrapSuite, wrapBlob,
		); err != nil {
			return fmt.Errorf("replace password seed wrap: %w", err)
		}
		return nil
	})
}

// ResetAuthViaRecovery atomically installs a new password after a verified
// recovery phrase, optionally clearing TOTP (for the lost-authenticator case),
// and deletes ALL password-method seed wraps: they were sealed under the old
// password's KEK and are unopenable garbage now. The client re-creates the
// wrap from the encryption phrase after logging in.
func (s *Store) ResetAuthViaRecovery(
	ctx context.Context,
	userID uuid.UUID,
	proofHash, salt []byte,
	alg int16,
	memKiB, iters, par int32,
	resetTOTP bool,
) error {
	if len(proofHash) == 0 || len(salt) == 0 {
		return fmt.Errorf("ResetAuthViaRecovery: proof and salt required")
	}
	return s.withTx(ctx, func(tx pgx.Tx) error {
		// Upsert: a pre-migration user may have no user_auth row yet; the
		// recovery path is exactly where such a user lands after losing
		// their passkey, so create the row rather than 404ing them.
		if _, err := tx.Exec(ctx,
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
			userID, proofHash, salt, alg, memKiB, iters, par,
		); err != nil {
			return fmt.Errorf("reset password auth: %w", err)
		}
		if resetTOTP {
			if _, err := tx.Exec(ctx,
				`UPDATE user_auth
				    SET totp_secret_enc = NULL,
				        totp_pending_secret_enc = NULL,
				        totp_confirmed_at = NULL,
				        totp_last_step = 0,
				        failed_totp_count = 0,
				        locked_until = NULL,
				        updated_at = now()
				  WHERE user_id = $1`,
				userID,
			); err != nil {
				return fmt.Errorf("clear totp: %w", err)
			}
		}
		if _, err := tx.Exec(ctx,
			`DELETE FROM identity_seed_wrap
			  WHERE user_id = $1 AND method = 'password'`,
			userID,
		); err != nil {
			return fmt.Errorf("delete stale password wraps: %w", err)
		}
		return nil
	})
}

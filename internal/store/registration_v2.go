// chalk -- phase31-slice31-6a transactional v2 registration.
//
// RegisterUserV2 is the auth-v2 sibling of RegisterUser: instead of a passkey
// it commits the password + confirmed-TOTP auth row. Three writes in one
// transaction -- users, user_auth (auth_v2_enrolled=true from birth: a v2
// account never passes through the migration gate), recovery_codes -- so a
// half-applied signup can never leave a user without auth or recovery.
package store

import (
	"context"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// RegistrationV2Params is everything a v2 signup commits. The caller has
// already live-verified the TOTP code against the plaintext secret; only the
// encrypted form arrives here.
type RegistrationV2Params struct {
	UserID      uuid.UUID
	Username    string
	DisplayName string
	Email       string

	RecoveryHash []byte // salt||argon2id bundle from auth.HashRecoveryWords

	AuthProofHash []byte
	AuthSalt      []byte
	KDFAlg        int16
	KDFMemKiB     int32
	KDFIters      int32
	KDFPar        int32

	TOTPSecretEnc []byte // AES-GCM blob under CHALK_TOTP_ENC_KEY
}

// RegisterUserV2 inserts users + user_auth + recovery_codes atomically.
// Returns ErrUsernameTaken / ErrEmailTaken on the corresponding collisions.
func (s *Store) RegisterUserV2(ctx context.Context, p RegistrationV2Params) error {
	if p.UserID == uuid.Nil {
		return fmt.Errorf("RegisterUserV2: UserID required")
	}
	if p.Username == "" || p.Email == "" {
		return fmt.Errorf("RegisterUserV2: Username and Email required")
	}
	if len(p.RecoveryHash) == 0 {
		return fmt.Errorf("RegisterUserV2: RecoveryHash required")
	}
	if len(p.AuthProofHash) == 0 || len(p.AuthSalt) == 0 {
		return fmt.Errorf("RegisterUserV2: AuthProofHash and AuthSalt required")
	}
	if len(p.TOTPSecretEnc) == 0 {
		return fmt.Errorf("RegisterUserV2: TOTPSecretEnc required")
	}
	displayName := p.DisplayName
	if displayName == "" {
		displayName = p.Username
	}

	return s.withTx(ctx, func(tx pgx.Tx) error {
		// 1. users row (mirrors RegisterUser: handle backfilled from
		// username for wire compatibility; email_verified_at NULL).
		if _, err := tx.Exec(ctx,
			`INSERT INTO users (
			   id, handle, username, display_name, email,
			   role, email_verified_at
			 ) VALUES (
			   $1, $2::citext, $2::citext, $3, $4::citext,
			   'user', NULL
			 )`,
			p.UserID, p.Username, displayName, p.Email,
		); err != nil {
			if isUserUniqueViolation(err, "username") || isUserUniqueViolation(err, "handle") {
				return ErrUsernameTaken
			}
			if isUserUniqueViolation(err, "email") {
				return ErrEmailTaken
			}
			return fmt.Errorf("insert user: %w", err)
		}

		// 2. user_auth row: password + confirmed TOTP, enrolled from birth.
		if _, err := tx.Exec(ctx,
			`INSERT INTO user_auth (
			   user_id, auth_proof_hash, auth_salt, kdf_alg, kdf_mem_kib,
			   kdf_iters, kdf_par, totp_secret_enc, totp_confirmed_at,
			   auth_v2_enrolled
			 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), true)`,
			p.UserID, p.AuthProofHash, p.AuthSalt, p.KDFAlg, p.KDFMemKiB,
			p.KDFIters, p.KDFPar, p.TOTPSecretEnc,
		); err != nil {
			return fmt.Errorf("insert user_auth: %w", err)
		}

		// 3. recovery_codes row.
		if _, err := tx.Exec(ctx,
			`INSERT INTO recovery_codes (user_id, hash, created_at, used_at)
			   VALUES ($1, $2, now(), NULL)`,
			p.UserID, p.RecoveryHash,
		); err != nil {
			return fmt.Errorf("insert recovery code: %w", err)
		}
		return nil
	})
}

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
	"errors"
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

	// Role is the users.role to insert. Empty means 'user'. The only
	// other accepted value is 'admin', used when an admin-token-bearing
	// signup claims the reserved admin username on a deployment where
	// chalkd never seeded an admin row (CHALK_ADMIN_USERNAME unset).
	// When a seeded row DOES exist the caller uses ClaimAdminV2
	// instead, which adopts that row and leaves its role alone.
	Role string

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
	role := p.Role
	if role == "" {
		role = "user"
	}
	if role != "user" && role != "admin" {
		return fmt.Errorf("RegisterUserV2: unsupported role %q", role)
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
			   $5, NULL
			 )`,
			p.UserID, p.Username, displayName, p.Email, role,
		); err != nil {
			if isUserUniqueViolation(err, "username") || isUserUniqueViolation(err, "handle") {
				return ErrUsernameTaken
			}
			if isUserUniqueViolation(err, "email") {
				return ErrEmailTaken
			}
			return fmt.Errorf("insert user: %w", err)
		}

		// 2 + 3. auth row and recovery code.
		return insertV2Credentials(ctx, tx, p)
	})
}

// insertV2Credentials writes the user_auth + recovery_codes rows for a
// v2 account. Shared by RegisterUserV2 (fresh insert) and ClaimAdminV2
// (adoption of the seeded admin row) so the two paths can never drift
// on what "enrolled in auth v2" means.
func insertV2Credentials(ctx context.Context, tx pgx.Tx, p RegistrationV2Params) error {
	// user_auth row: password + confirmed TOTP, enrolled from birth.
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

	// recovery_codes row. Upsert rather than plain insert: the claim
	// path adopts a pre-existing users row, and a stale recovery row
	// there must not fail the whole ceremony.
	if _, err := tx.Exec(ctx,
		`INSERT INTO recovery_codes (user_id, hash, created_at, used_at)
		   VALUES ($1, $2, now(), NULL)
		   ON CONFLICT (user_id) DO UPDATE
		     SET hash = EXCLUDED.hash,
		         created_at = now(),
		         used_at = NULL`,
		p.UserID, p.RecoveryHash,
	); err != nil {
		return fmt.Errorf("insert recovery code: %w", err)
	}
	return nil
}

// ErrAdminAlreadyClaimed is returned by ClaimAdminV2 when the target row
// is no longer an unclaimed admin — either someone else completed the
// claim in the window between signup begin and finish, or the row grew
// credentials by some other path. The HTTP layer maps it to 409.
var ErrAdminAlreadyClaimed = errors.New("admin account has already been claimed")

// ClaimAdminV2 takes possession of the admin row chalkd seeded at first
// boot: it attaches the password + confirmed-TOTP credentials to the
// EXISTING user id rather than inserting a new user.
//
// Adopting the row instead of creating one is what preserves the admin
// identity — role stays 'admin' (never rewritten here) and the user id
// stays stable, so anything that already references it keeps working.
//
// The unclaimed precondition is re-checked under FOR UPDATE inside the
// transaction. The HTTP layer already checked it at signup/begin, but
// the TOTP enrollment happens in between, so the check has to be
// repeated where it can actually be relied on.
func (s *Store) ClaimAdminV2(ctx context.Context, p RegistrationV2Params) error {
	if p.UserID == uuid.Nil {
		return fmt.Errorf("ClaimAdminV2: UserID required")
	}
	if p.Username == "" || p.Email == "" {
		return fmt.Errorf("ClaimAdminV2: Username and Email required")
	}
	if len(p.RecoveryHash) == 0 {
		return fmt.Errorf("ClaimAdminV2: RecoveryHash required")
	}
	if len(p.AuthProofHash) == 0 || len(p.AuthSalt) == 0 {
		return fmt.Errorf("ClaimAdminV2: AuthProofHash and AuthSalt required")
	}
	if len(p.TOTPSecretEnc) == 0 {
		return fmt.Errorf("ClaimAdminV2: TOTPSecretEnc required")
	}
	displayName := p.DisplayName
	if displayName == "" {
		displayName = p.Username
	}

	return s.withTx(ctx, func(tx pgx.Tx) error {
		var id uuid.UUID
		err := tx.QueryRow(ctx,
			`SELECT id FROM users
			  WHERE id = $1 AND`+unclaimedAdminWhere+`
			  FOR UPDATE`,
			p.UserID,
		).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrAdminAlreadyClaimed
		}
		if err != nil {
			return fmt.Errorf("lock admin row: %w", err)
		}

		// The operator may have entered a different display name or
		// email than the seed values from the environment; theirs win.
		// username/role/id are deliberately untouched.
		if _, err := tx.Exec(ctx,
			`UPDATE users
			    SET display_name = $2, email = $3::citext
			  WHERE id = $1`,
			p.UserID, displayName, p.Email,
		); err != nil {
			if isUserUniqueViolation(err, "email") {
				return ErrEmailTaken
			}
			return fmt.Errorf("update admin row: %w", err)
		}

		return insertV2Credentials(ctx, tx, p)
	})
}

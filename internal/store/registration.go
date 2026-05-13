// Package store: registration helper.
//
// Phase 09b sub-step 3 lands the transactional RegisterUser path. It
// composes the three writes that a fresh registration entails — users
// row, passkeys row, recovery_codes row — into one transaction so a
// half-applied registration never leaves an orphan user with no
// passkey (which would be a footgun for the next attempt) or a user
// with no recovery code (locking them out of the safety net we just
// promised).
//
// This file lives separately from users.go because the existing
// CreateUser/UpsertUser methods are pre-09b primitives used by tests
// and fixtures. RegisterUser is the new front-door for production
// signups; we keep them in different files so the boundary stays
// readable.
package store

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// RegistrationParams is everything the auth-layer needs to commit a
// fresh registration to the database. It's a value object; the store
// does no validation beyond what the database itself enforces (the
// username regex, citext uniqueness, foreign keys).
type RegistrationParams struct {
	// User identity.
	UserID      uuid.UUID
	Username    string
	DisplayName string
	Email       string

	// Passkey. The auth layer produced these from a successful
	// CreateCredential ceremony.
	CredentialID   []byte
	PublicKey      []byte
	SignCount      uint64
	Transports     []string
	PasskeyName    string // human label; may be empty

	// Recovery. Hash is the salt||argon2id-hash bundle returned by
	// auth.HashRecoveryWords (48 bytes: 16 salt + 32 hash). The
	// caller MUST have already shown the plaintext words to the
	// user; the words themselves never reach this layer.
	RecoveryHash []byte
}

// ErrUsernameTaken is returned by RegisterUser when the chosen
// username collides with an existing user. The HTTP layer maps it
// to 409 Conflict. The check is at the database level (citext
// uniqueness on users.username), so it's race-free across
// concurrent registration attempts.
var ErrUsernameTaken = errors.New("username already taken")

// ErrEmailTaken is the equivalent for email collisions.
var ErrEmailTaken = errors.New("email already in use")

// ErrCredentialTaken is returned if the WebAuthn credential ID is
// already present in the passkeys table. In practice this should
// never happen (credential IDs are 32+ bytes of cryptographic
// randomness) but the check is cheap and prevents a confusing
// PG error from leaking.
var ErrCredentialTaken = errors.New("credential already registered")

// RegisterUser inserts the three rows that constitute a fresh
// account in one transaction. On any error all three rolls back.
// Returns ErrUsernameTaken/ErrEmailTaken/ErrCredentialTaken for
// the corresponding unique-violation cases.
//
// Pre-conditions enforced by the caller (not re-checked here):
//   - Username matches the shape regex ^[a-z0-9_]{3,32}$
//   - Username is not on the reserved list
//   - Email is non-empty (RFC validation is the SPA's job)
//   - DisplayName is non-empty (defaults to Username if SPA didn't supply one)
//   - CredentialID, PublicKey, RecoveryHash are non-empty
//
// Post-conditions on success:
//   - users row exists with role='user', email_verified_at=NULL
//     (verification happens out-of-band; sub-step 3 doesn't gate on it),
//     handle backfilled from username for wire compatibility with
//     pre-09b clients
//   - passkeys row tied to user
//   - recovery_codes row with the provided hash; used_at=NULL
func (s *Store) RegisterUser(ctx context.Context, p RegistrationParams) error {
	if p.UserID == uuid.Nil {
		return fmt.Errorf("RegisterUser: UserID required")
	}
	if p.Username == "" {
		return fmt.Errorf("RegisterUser: Username required")
	}
	if p.Email == "" {
		return fmt.Errorf("RegisterUser: Email required")
	}
	if len(p.CredentialID) == 0 {
		return fmt.Errorf("RegisterUser: CredentialID required")
	}
	if len(p.PublicKey) == 0 {
		return fmt.Errorf("RegisterUser: PublicKey required")
	}
	if len(p.RecoveryHash) == 0 {
		return fmt.Errorf("RegisterUser: RecoveryHash required")
	}
	displayName := p.DisplayName
	if displayName == "" {
		displayName = p.Username
	}
	transports := p.Transports
	if transports == nil {
		transports = []string{}
	}

	return s.withTx(ctx, func(tx pgx.Tx) error {
		// 1. users row.
		//
		// handle is backfilled from username (citext) so pre-09b
		// wire frames that send handle still resolve to a row.
		// email_verified_at is NULL on registration; verification
		// is an out-of-band step that 09b doesn't gate on (the
		// plan defers verification gates to sub-step 09b-5).
		//
		// role defaults to 'user'. The admin's first-run flow
		// upgrades to 'admin' separately in sub-step 09b-5's
		// admin-bootstrap CLI.
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

		// 2. passkeys row. AddPasskey's table layout (see
		// passkeys.go) is duplicated here so the whole thing is
		// in one tx; we don't reach into AddPasskey from inside
		// the tx because that method takes a pool, not a tx.
		var passkeyName any
		if p.PasskeyName != "" {
			passkeyName = p.PasskeyName
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO passkeys (
			   credential_id, user_id, public_key,
			   sign_count, transports, name, created_at
			 ) VALUES ($1, $2, $3, $4, $5, $6, now())`,
			p.CredentialID, p.UserID, p.PublicKey,
			int64(p.SignCount), transports, passkeyName,
		); err != nil {
			if isPasskeyUniqueViolation(err) {
				return ErrCredentialTaken
			}
			return fmt.Errorf("insert passkey: %w", err)
		}

		// 3. recovery_codes row. SetRecoveryCode (see
		// recovery_codes.go) does upsert-on-conflict; here we
		// straight-insert because we know the row doesn't exist
		// yet (we just inserted the user).
		if _, err := tx.Exec(ctx,
			`INSERT INTO recovery_codes (
			   user_id, hash, created_at
			 ) VALUES ($1, $2, now())`,
			p.UserID, p.RecoveryHash,
		); err != nil {
			return fmt.Errorf("insert recovery_code: %w", err)
		}

		return nil
	})
}

// isUserUniqueViolation reports whether err is a PG unique_violation
// on the named users column. The check is by substring of the PG
// error text rather than by pgx error code because the constraint
// names depend on the migration's index naming. This is the same
// approach admin_bootstrap.go uses for its own unique checks.
func isUserUniqueViolation(err error, col string) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	if !strings.Contains(msg, "unique") && !strings.Contains(msg, "duplicate") {
		return false
	}
	// PG renders "Key (username)=(...)" or similar in detail.
	return strings.Contains(msg, "("+col+")") ||
		strings.Contains(msg, "_"+col+"_") ||
		strings.Contains(msg, "users_"+col)
}

// isPasskeyUniqueViolation reports whether err is the credential_id
// unique-violation on the passkeys table. credential_id IS the
// primary key, so the PG error mentions the pkey constraint name.
func isPasskeyUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return (strings.Contains(msg, "unique") || strings.Contains(msg, "duplicate")) &&
		strings.Contains(msg, "passkeys")
}

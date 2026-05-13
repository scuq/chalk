package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// RecoveryCode is the per-user recovery code state. The 24-word
// phrase itself is never stored; only an argon2id hash of it is.
// The application hashes incoming candidate phrases at verification
// time and constant-time compares.
//
// At most one row per user (PRIMARY KEY user_id). UsedAt is set when
// the code is consumed; the application must immediately call
// SetRecoveryCode again to install a new code so the user is not
// left without recovery.
type RecoveryCode struct {
	UserID    uuid.UUID
	Hash      []byte
	CreatedAt time.Time
	UsedAt    time.Time // zero if unused
}

// HasBeenUsed returns true when the code was consumed.
func (r RecoveryCode) HasBeenUsed() bool {
	return !r.UsedAt.IsZero()
}

// SetRecoveryCode upserts the recovery code row for userID. Used at
// registration (no row exists yet) and at every regeneration. Resets
// used_at to NULL.
//
// hash is the application-computed argon2id hash; the store does not
// hash anything itself.
func (s *Store) SetRecoveryCode(ctx context.Context, userID uuid.UUID, hash []byte) error {
	if len(hash) == 0 {
		return fmt.Errorf("SetRecoveryCode: hash required")
	}
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO recovery_codes (user_id, hash, created_at, used_at)
		   VALUES ($1, $2, now(), NULL)
		   ON CONFLICT (user_id) DO UPDATE
		     SET hash = EXCLUDED.hash,
		         created_at = now(),
		         used_at = NULL`,
		userID, hash,
	)
	if err != nil {
		return fmt.Errorf("set recovery code: %w", err)
	}
	return nil
}

// GetRecoveryCode fetches the row for userID. Returns ErrNotFound if
// the user has never had one. Callers comparing hashes should treat
// a row with used_at != NULL as "no valid code"; the application's
// auth layer enforces single-use semantics.
func (s *Store) GetRecoveryCode(ctx context.Context, userID uuid.UUID) (RecoveryCode, error) {
	var r RecoveryCode
	var usedAt *time.Time
	err := s.Pool.QueryRow(ctx,
		`SELECT user_id, hash, created_at, used_at
		   FROM recovery_codes WHERE user_id = $1`,
		userID,
	).Scan(&r.UserID, &r.Hash, &r.CreatedAt, &usedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return RecoveryCode{}, ErrNotFound
	}
	if err != nil {
		return RecoveryCode{}, fmt.Errorf("get recovery code: %w", err)
	}
	if usedAt != nil {
		r.UsedAt = *usedAt
	}
	return r, nil
}

// MarkRecoveryCodeUsed sets used_at = now() iff the row exists and
// has not already been used. Returns ErrAlreadyUsed if the row was
// already consumed (defense against accidental double-redemption).
// Returns ErrNotFound if no row exists.
func (s *Store) MarkRecoveryCodeUsed(ctx context.Context, userID uuid.UUID) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE recovery_codes
		    SET used_at = now()
		  WHERE user_id = $1
		    AND used_at IS NULL`,
		userID,
	)
	if err != nil {
		return fmt.Errorf("mark recovery code used: %w", err)
	}
	if tag.RowsAffected() == 0 {
		// Either the row doesn't exist or it's already used. Distinguish
		// for callers who want different error UX.
		var exists bool
		err := s.Pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM recovery_codes WHERE user_id = $1)`,
			userID,
		).Scan(&exists)
		if err != nil {
			return fmt.Errorf("post-update check: %w", err)
		}
		if exists {
			return ErrRecoveryCodeAlreadyUsed
		}
		return ErrNotFound
	}
	return nil
}

// ErrRecoveryCodeAlreadyUsed is returned by MarkRecoveryCodeUsed when
// the row exists but already had a non-NULL used_at.
var ErrRecoveryCodeAlreadyUsed = errors.New("recovery code already used")

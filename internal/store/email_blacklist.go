package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Phase 09c: email blacklist.
//
// The blacklist is consulted at registration and email-change time
// to prevent re-use of emails that an admin (or the system) has
// flagged. The primary writer in 09c is empty — the table is created
// here but populated only via 09d's admin moderation flows (purge
// auto-adds; admin can manually add/remove). The lookup is wired
// into validation now so 09d doesn't have to retrofit it.

// BlacklistEntry mirrors the email_blacklist table row.
type BlacklistEntry struct {
	Email          string // CITEXT on PG side
	Reason         string
	AddedAt        time.Time
	AddedBy        uuid.UUID // uuid.Nil if not associated with a user
	FormerUserID   uuid.UUID // uuid.Nil if not from a purge
	FormerUsername string    // empty if not from a purge
}

// IsEmailBlacklisted returns true if the given email has a row in
// the blacklist. Case-insensitive (the column is CITEXT). Used by
// validation paths in the auth HTTP layer.
//
// Returns an error only on DB failure; a missing row is reported as
// (false, nil), the expected common case.
func (s *Store) IsEmailBlacklisted(ctx context.Context, email string) (bool, error) {
	if email == "" {
		return false, nil
	}
	var dummy int
	err := s.Pool.QueryRow(ctx,
		`SELECT 1 FROM email_blacklist WHERE email = $1`,
		email,
	).Scan(&dummy)
	if errors.Is(err, pgx.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("check email blacklist: %w", err)
	}
	return true, nil
}

// AddToBlacklistParams is the input to AddToBlacklist.
type AddToBlacklistParams struct {
	Email          string
	Reason         string    // required, free-form
	AddedBy        uuid.UUID // uuid.Nil OK
	FormerUserID   uuid.UUID // uuid.Nil OK
	FormerUsername string    // empty OK
}

// AddToBlacklist inserts a new blacklist entry. Idempotent: if a row
// already exists for this email, the existing row is kept (ON
// CONFLICT DO NOTHING). 09d will use this from the purge flow; 09c
// just exposes the helper for completeness and unit testing.
func (s *Store) AddToBlacklist(ctx context.Context, params AddToBlacklistParams) error {
	if params.Email == "" {
		return fmt.Errorf("AddToBlacklist: email required")
	}
	if params.Reason == "" {
		return fmt.Errorf("AddToBlacklist: reason required")
	}
	var addedBy, formerUser *uuid.UUID
	if params.AddedBy != uuid.Nil {
		addedBy = &params.AddedBy
	}
	if params.FormerUserID != uuid.Nil {
		formerUser = &params.FormerUserID
	}
	var formerUsername *string
	if params.FormerUsername != "" {
		formerUsername = &params.FormerUsername
	}
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO email_blacklist
		   (email, reason, added_by, former_user_id, former_username)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (email) DO NOTHING`,
		params.Email, params.Reason, addedBy, formerUser, formerUsername,
	)
	if err != nil {
		return fmt.Errorf("add to blacklist: %w", err)
	}
	return nil
}

// RemoveFromBlacklist deletes the row for email if present. Returns
// nil whether or not a row was deleted (idempotent admin action).
// 09d's admin UI calls this; 09c provides the helper.
func (s *Store) RemoveFromBlacklist(ctx context.Context, email string) error {
	if email == "" {
		return fmt.Errorf("RemoveFromBlacklist: email required")
	}
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM email_blacklist WHERE email = $1`,
		email,
	)
	if err != nil {
		return fmt.Errorf("remove from blacklist: %w", err)
	}
	return nil
}

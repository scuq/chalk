package store

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Phase 09c: invite tokens.
//
// An invite is a single-use, time-limited token authorizing one
// specific email address to register a chalk account. Created by
// existing users (anyone can invite); validated at registration; the
// application uses the email + inviter relationship for audit and
// the registration UI.
//
// State machine: an invite row is in one of these states based on
// timestamp fields:
//
//   - active:    used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
//   - used:      used_at IS NOT NULL
//   - revoked:   revoked_at IS NOT NULL
//   - expired:   used_at IS NULL AND revoked_at IS NULL AND expires_at <= now()
//
// Application code shouldn't compute the state in Go; the InviteStatus()
// helper returns the canonical string for display/comparison.

// ErrInviteEmailActive: an active invite already exists for this
// email. Returned by CreateInvite when the partial unique index
// fires.
var ErrInviteEmailActive = errors.New("active invite already exists for this email")

// ErrInviteNotUsable: returned by MarkInviteUsed when the invite is
// already used, revoked, or expired at lock time. Distinct from
// ErrNotFound (the row exists, just can't be consumed).
var ErrInviteNotUsable = errors.New("invite is not usable (used / revoked / expired)")

// Invite mirrors the invites table. Token is the raw 32-byte
// PRIMARY KEY (base64url-encoded on the HTTP wire).
type Invite struct {
	Token     []byte
	Email     string // CITEXT on the DB side; passed as-is in Go
	InviterID uuid.UUID
	Note      string // may be empty
	CreatedAt time.Time
	ExpiresAt time.Time
	UsedAt    time.Time // zero if unused
	UsedBy    uuid.UUID // uuid.Nil if unused
	RevokedAt time.Time // zero if not revoked
}

// IsUsed returns true if the invite has been consumed by a registration.
func (i Invite) IsUsed() bool { return !i.UsedAt.IsZero() }

// IsRevoked returns true if the inviter explicitly revoked it.
func (i Invite) IsRevoked() bool { return !i.RevokedAt.IsZero() }

// IsExpired returns true if the invite's expires_at is in the past.
// Note: this is a snapshot-time check; the DB enforces the same
// semantics in the partial unique index.
func (i Invite) IsExpired() bool { return time.Now().After(i.ExpiresAt) }

// IsActive returns true when the invite is consumable: not used,
// not revoked, not expired.
func (i Invite) IsActive() bool {
	return !i.IsUsed() && !i.IsRevoked() && !i.IsExpired()
}

// Status returns "active", "used", "revoked", or "expired". Stable
// strings; the SPA's UI uses these directly. Priority order: used >
// revoked > expired > active. (A used invite is technically also
// "expired" by time but "used" is the more meaningful state.)
func (i Invite) Status() string {
	switch {
	case i.IsUsed():
		return "used"
	case i.IsRevoked():
		return "revoked"
	case i.IsExpired():
		return "expired"
	default:
		return "active"
	}
}

// CreateInviteParams is the input to CreateInvite. The caller is
// responsible for generating Token via auth.GenerateInviteToken (or
// equivalent CSPRNG) and computing ExpiresAt = now() + TTL.
type CreateInviteParams struct {
	Token     []byte
	Email     string
	InviterID uuid.UUID
	Note      string // optional, may be empty
	ExpiresAt time.Time
}

// CreateInvite inserts a new invite row. Returns ErrInviteEmailActive
// if the partial unique index fires (another active invite exists
// for this email). The token must be 32 bytes (enforced at the
// application layer; the DB only requires non-null).
func (s *Store) CreateInvite(ctx context.Context, params CreateInviteParams) (Invite, error) {
	if len(params.Token) == 0 {
		return Invite{}, fmt.Errorf("CreateInvite: token required")
	}
	if params.Email == "" {
		return Invite{}, fmt.Errorf("CreateInvite: email required")
	}
	if params.InviterID == uuid.Nil {
		return Invite{}, fmt.Errorf("CreateInvite: inviter_id required")
	}
	if params.ExpiresAt.IsZero() {
		return Invite{}, fmt.Errorf("CreateInvite: expires_at required")
	}

	var inv Invite
	err := s.Pool.QueryRow(ctx,
		`INSERT INTO invites (token, email, inviter_id, note, expires_at)
		   VALUES ($1, $2, $3, NULLIF($4, ''), $5)
		   RETURNING token, email, inviter_id, COALESCE(note, ''),
		             created_at, expires_at`,
		params.Token, params.Email, params.InviterID, params.Note, params.ExpiresAt,
	).Scan(
		&inv.Token, &inv.Email, &inv.InviterID, &inv.Note,
		&inv.CreatedAt, &inv.ExpiresAt,
	)
	if err != nil {
		// Detect partial unique index violation by message scan,
		// matching the convention used by registration.go and
		// admin_bootstrap.go. The constraint name "invites_active_email_idx"
		// appears in PG's detail message on conflict.
		msg := strings.ToLower(err.Error())
		isUnique := strings.Contains(msg, "unique") || strings.Contains(msg, "duplicate")
		if isUnique && strings.Contains(msg, "invites_active_email_idx") {
			return Invite{}, ErrInviteEmailActive
		}
		// Token collision is astronomically unlikely with 32
		// CSPRNG bytes; surface it as a generic error to retry.
		return Invite{}, fmt.Errorf("create invite: %w", err)
	}
	return inv, nil
}

// GetInvite looks up an invite by its raw token. Returns ErrNotFound
// if no row matches. The returned invite carries every status field
// so the caller can decide what to do (e.g. show "this invite has
// already been used" in the SPA).
func (s *Store) GetInvite(ctx context.Context, token []byte) (Invite, error) {
	if len(token) == 0 {
		return Invite{}, fmt.Errorf("GetInvite: token required")
	}
	var inv Invite
	var usedAt, revokedAt *time.Time
	var usedBy *uuid.UUID
	err := s.Pool.QueryRow(ctx,
		`SELECT token, email, inviter_id, COALESCE(note, ''),
		        created_at, expires_at, used_at, used_by, revoked_at
		   FROM invites
		  WHERE token = $1`,
		token,
	).Scan(
		&inv.Token, &inv.Email, &inv.InviterID, &inv.Note,
		&inv.CreatedAt, &inv.ExpiresAt,
		&usedAt, &usedBy, &revokedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return Invite{}, ErrNotFound
	}
	if err != nil {
		return Invite{}, fmt.Errorf("get invite: %w", err)
	}
	if usedAt != nil {
		inv.UsedAt = *usedAt
	}
	if usedBy != nil {
		inv.UsedBy = *usedBy
	}
	if revokedAt != nil {
		inv.RevokedAt = *revokedAt
	}
	return inv, nil
}

// MarkInviteUsed atomically transitions an active invite to used,
// recording the consuming user. Returns ErrNotFound if the token
// doesn't exist; ErrInviteNotUsable if it exists but isn't active
// (already used, revoked, or expired at this moment).
//
// Called inside the registration transaction so a concurrent
// registration on the same token will fail the second attempt.
func (s *Store) MarkInviteUsed(ctx context.Context, token []byte, usedBy uuid.UUID) error {
	if len(token) == 0 {
		return fmt.Errorf("MarkInviteUsed: token required")
	}
	if usedBy == uuid.Nil {
		return fmt.Errorf("MarkInviteUsed: usedBy required")
	}
	// Atomic transition: only flip if currently active. The WHERE
	// re-evaluates active-ness so two concurrent claimers race here
	// and only one wins.
	tag, err := s.Pool.Exec(ctx,
		`UPDATE invites
		    SET used_at = now(),
		        used_by = $2
		  WHERE token = $1
		    AND used_at IS NULL
		    AND revoked_at IS NULL
		    AND expires_at > now()`,
		token, usedBy,
	)
	if err != nil {
		return fmt.Errorf("mark invite used: %w", err)
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	// Zero rows updated: either the token doesn't exist or it's no
	// longer active. Distinguish via a second lookup.
	if _, getErr := s.GetInvite(ctx, token); errors.Is(getErr, ErrNotFound) {
		return ErrNotFound
	}
	return ErrInviteNotUsable
}

// RevokeInvite sets revoked_at = now() for an active invite owned by
// inviterID. Returns ErrNotFound if the invite doesn't exist or
// isn't owned by this user; ErrInviteNotUsable if it exists but
// isn't active (already used, already revoked, or expired). The
// inviter ownership check is enforced in SQL so the API can't
// accidentally revoke someone else's invite.
func (s *Store) RevokeInvite(ctx context.Context, token []byte, inviterID uuid.UUID) error {
	if len(token) == 0 {
		return fmt.Errorf("RevokeInvite: token required")
	}
	tag, err := s.Pool.Exec(ctx,
		`UPDATE invites
		    SET revoked_at = now()
		  WHERE token = $1
		    AND inviter_id = $2
		    AND used_at IS NULL
		    AND revoked_at IS NULL
		    AND expires_at > now()`,
		token, inviterID,
	)
	if err != nil {
		return fmt.Errorf("revoke invite: %w", err)
	}
	if tag.RowsAffected() == 1 {
		return nil
	}
	// Distinguish "not yours / not found" from "not active".
	inv, getErr := s.GetInvite(ctx, token)
	if errors.Is(getErr, ErrNotFound) {
		return ErrNotFound
	}
	if getErr != nil {
		return fmt.Errorf("revoke invite: lookup: %w", getErr)
	}
	if inv.InviterID != inviterID {
		// Don't disclose existence to non-owners.
		return ErrNotFound
	}
	return ErrInviteNotUsable
}

// ListInvitesByInviter returns every invite created by inviterID,
// newest-first. Used for the "my invites" SPA panel. No pagination
// for now; users won't have hundreds of pending invites at once
// (and if they do, the SPA can scroll).
func (s *Store) ListInvitesByInviter(ctx context.Context, inviterID uuid.UUID) ([]Invite, error) {
	if inviterID == uuid.Nil {
		return nil, fmt.Errorf("ListInvitesByInviter: inviter_id required")
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT token, email, inviter_id, COALESCE(note, ''),
		        created_at, expires_at, used_at, used_by, revoked_at
		   FROM invites
		  WHERE inviter_id = $1
		  ORDER BY created_at DESC`,
		inviterID,
	)
	if err != nil {
		return nil, fmt.Errorf("list invites: %w", err)
	}
	defer rows.Close()

	var out []Invite
	for rows.Next() {
		var inv Invite
		var usedAt, revokedAt *time.Time
		var usedBy *uuid.UUID
		if err := rows.Scan(
			&inv.Token, &inv.Email, &inv.InviterID, &inv.Note,
			&inv.CreatedAt, &inv.ExpiresAt,
			&usedAt, &usedBy, &revokedAt,
		); err != nil {
			return nil, fmt.Errorf("list invites: scan: %w", err)
		}
		if usedAt != nil {
			inv.UsedAt = *usedAt
		}
		if usedBy != nil {
			inv.UsedBy = *usedBy
		}
		if revokedAt != nil {
			inv.RevokedAt = *revokedAt
		}
		out = append(out, inv)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list invites: rows: %w", err)
	}
	return out, nil
}

// DeleteExpiredInvites removes invites that have expired AND haven't
// been used/revoked. We keep used and revoked rows around for audit;
// only the silent-expiry path gets cleaned up.
//
// "Silent expiry" doesn't carry useful audit data (no one took
// action; the invite just timed out), so deletion is fine. Called
// hourly by the janitor in cmd/chalkd/main.go.
//
// Returns the number of rows deleted.
func (s *Store) DeleteExpiredInvites(ctx context.Context) (int64, error) {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM invites
		  WHERE used_at IS NULL
		    AND revoked_at IS NULL
		    AND expires_at <= now()`,
	)
	if err != nil {
		return 0, fmt.Errorf("delete expired invites: %w", err)
	}
	return tag.RowsAffected(), nil
}

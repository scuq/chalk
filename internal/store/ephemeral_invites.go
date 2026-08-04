package store

// 80-7: ephemeral guest invites (docs/phases/PHASE-80-EPHEMERAL.md). One row per
// magic link, holding the public material the creator derived from the link
// secret. Rows live until the channel is purged -- an EXPIRED invite may
// still name a live guest (via ephemeral_guests.invite_lookup), so nothing
// sweeps them on expiry; expiry only gates redemption.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

// ErrGuestLimit is returned when a mint would exceed the channel's guest cap.
var ErrGuestLimit = errors.New("guest limit reached")

// ErrNotEphemeral is returned when an invite operation targets a channel
// without an expiry.
var ErrNotEphemeral = errors.New("channel is not ephemeral")

// ErrInviteExists is returned when a mint collides with an existing invite
// (same lookup or same reserved guest id).
var ErrInviteExists = errors.New("invite already exists")

// EphemeralInvite is one row of ephemeral_invites.
type EphemeralInvite struct {
	Lookup      []byte
	ChannelID   uuid.UUID
	CreatedBy   uuid.UUID
	GuestUserID uuid.UUID
	X25519Pub   []byte
	Ed25519Pub  []byte
	SelfSig     []byte
	KeyVersion  int
	WrapSuite   int
	WrapBlob    []byte
	Label       string
	CreatedAt   time.Time
	ExpiresAt   time.Time
	RedeemedAt  *time.Time
	RevokedAt   *time.Time
}

// MintEphemeralInvite inserts one invite, enforcing the per-channel guest cap
// atomically: the channel row is locked FOR UPDATE so two concurrent mints
// cannot both squeeze under the cap. Revoked invites do not count against it
// (revoking is how a mistaken link's slot is reclaimed). maxGuests <= 0 means
// no cap.
//
// Returns ErrChannelNotFound / ErrNotEphemeral for a missing or permanent
// channel, ErrGuestLimit at the cap, ErrInviteExists on a lookup or guest-id
// collision.
func (s *Store) MintEphemeralInvite(ctx context.Context, inv EphemeralInvite, maxGuests int) error {
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var expiresAt *time.Time
		qerr := tx.QueryRow(ctx,
			`SELECT expires_at FROM channels WHERE id = $1 FOR UPDATE`,
			inv.ChannelID,
		).Scan(&expiresAt)
		if errors.Is(qerr, pgx.ErrNoRows) {
			return ErrChannelNotFound
		}
		if qerr != nil {
			return fmt.Errorf("lock channel: %w", qerr)
		}
		if expiresAt == nil {
			return ErrNotEphemeral
		}

		if maxGuests > 0 {
			var n int
			if err := tx.QueryRow(ctx,
				`SELECT count(*) FROM ephemeral_invites
				  WHERE channel_id = $1 AND revoked_at IS NULL`,
				inv.ChannelID,
			).Scan(&n); err != nil {
				return fmt.Errorf("count invites: %w", err)
			}
			if n >= maxGuests {
				return fmt.Errorf("%w: %d of %d", ErrGuestLimit, n, maxGuests)
			}
		}

		if _, err := tx.Exec(ctx,
			`INSERT INTO ephemeral_invites
			   (lookup, channel_id, created_by, guest_user_id,
			    x25519_pub, ed25519_pub, self_sig,
			    key_version, wrap_suite, wrap_blob, label, expires_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
			inv.Lookup, inv.ChannelID, inv.CreatedBy, inv.GuestUserID,
			inv.X25519Pub, inv.Ed25519Pub, inv.SelfSig,
			inv.KeyVersion, inv.WrapSuite, inv.WrapBlob, inv.Label, inv.ExpiresAt,
		); err != nil {
			var pgErr *pgconn.PgError
			if errors.As(err, &pgErr) && pgErr.Code == "23505" {
				return ErrInviteExists
			}
			return fmt.Errorf("insert invite: %w", err)
		}
		return nil
	})
	return err
}

// ListEphemeralInvites returns a channel's invites, oldest first.
func (s *Store) ListEphemeralInvites(ctx context.Context, channelID uuid.UUID) ([]EphemeralInvite, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT lookup, channel_id, created_by, guest_user_id,
		        x25519_pub, ed25519_pub, self_sig,
		        key_version, wrap_suite, wrap_blob, label,
		        created_at, expires_at, redeemed_at, revoked_at
		   FROM ephemeral_invites
		  WHERE channel_id = $1
		  ORDER BY created_at`,
		channelID)
	if err != nil {
		return nil, fmt.Errorf("list invites: %w", err)
	}
	defer rows.Close()
	var out []EphemeralInvite
	for rows.Next() {
		var inv EphemeralInvite
		if err := rows.Scan(
			&inv.Lookup, &inv.ChannelID, &inv.CreatedBy, &inv.GuestUserID,
			&inv.X25519Pub, &inv.Ed25519Pub, &inv.SelfSig,
			&inv.KeyVersion, &inv.WrapSuite, &inv.WrapBlob, &inv.Label,
			&inv.CreatedAt, &inv.ExpiresAt, &inv.RedeemedAt, &inv.RevokedAt,
		); err != nil {
			return nil, fmt.Errorf("list invites: %w", err)
		}
		out = append(out, inv)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list invites: %w", err)
	}
	return out, nil
}

// RevokeEphemeralInvite marks one invite revoked. Idempotent from the
// caller's view is NOT wanted here: revoking an unknown (or already revoked)
// lookup returns ErrNotFound so the UI can tell a stale list from a success.
func (s *Store) RevokeEphemeralInvite(ctx context.Context, channelID uuid.UUID, lookup []byte) error {
	tag, err := s.Pool.Exec(ctx,
		`UPDATE ephemeral_invites SET revoked_at = now()
		  WHERE channel_id = $1 AND lookup = $2 AND revoked_at IS NULL`,
		channelID, lookup)
	if err != nil {
		return fmt.Errorf("revoke invite: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

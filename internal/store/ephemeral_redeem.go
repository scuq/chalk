package store

// 80-8: guest materialization (docs/PHASE-80-EPHEMERAL.md §"The guest row is
// materialized lazily"). One chalk_app transaction turns a parked invite into
// a full principal: users row (under the RESERVED uuid the wrap's AAD is
// bound to), ephemeral_guests, channel_members, ephemeral_identity_keys and
// channel_keys -- then mints an ephemeral_sessions row. Re-redemption (same
// link, new tab) skips the inserts and just mints a fresh session for the
// same identity: the secret derives the same keys, so blocking reuse would
// only lock out a guest who closed the tab.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Invite lifecycle errors the join endpoint maps to HTTP statuses.
var (
	ErrInviteExpired = errors.New("invite expired")
	ErrInviteRevoked = errors.New("invite revoked")
)

// GetEphemeralInvite returns one invite by lookup. ErrNotFound when absent.
func (s *Store) GetEphemeralInvite(ctx context.Context, lookup []byte) (EphemeralInvite, error) {
	var inv EphemeralInvite
	err := s.Pool.QueryRow(ctx,
		`SELECT lookup, channel_id, created_by, guest_user_id,
		        x25519_pub, ed25519_pub, self_sig,
		        key_version, wrap_suite, wrap_blob, label,
		        created_at, expires_at, redeemed_at, revoked_at
		   FROM ephemeral_invites WHERE lookup = $1`,
		lookup,
	).Scan(
		&inv.Lookup, &inv.ChannelID, &inv.CreatedBy, &inv.GuestUserID,
		&inv.X25519Pub, &inv.Ed25519Pub, &inv.SelfSig,
		&inv.KeyVersion, &inv.WrapSuite, &inv.WrapBlob, &inv.Label,
		&inv.CreatedAt, &inv.ExpiresAt, &inv.RedeemedAt, &inv.RevokedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return EphemeralInvite{}, ErrNotFound
	}
	if err != nil {
		return EphemeralInvite{}, fmt.Errorf("get invite: %w", err)
	}
	return inv, nil
}

// RedeemInput is what the join endpoint hands over after the challenge and
// signature checks passed.
type RedeemInput struct {
	Lookup      []byte
	DisplayName string // typed by the guest; 1..32 after trim, caller-validated
	UserAgent   string
	IP          net.IP
	// SessionTTL caps the guest session; it is additionally clamped to the
	// channel's own expiry -- a session must not outlive the room.
	SessionTTL time.Duration
}

// RedeemedGuest is everything the guest client needs to boot: its identity,
// the room, its parked space-key wrap, and the session.
type RedeemedGuest struct {
	UserID      uuid.UUID
	DisplayName string
	ChannelID   uuid.UUID
	ChannelName string
	// OwnerUserID is who minted the invite (82-7) -- the user id the guest's
	// client verifies the wrap's signature under. The signature binds this id,
	// so a server that mislabels the owner produces a verification failure
	// rather than an acceptance; the KEY the guest trusts arrives in the link
	// fragment, which this server never sees.
	OwnerUserID      uuid.UUID
	ChannelExpiresAt time.Time
	KeyVersion       int
	WrapSuite        int
	WrapBlob         []byte
	SessionToken     []byte
	SessionExpiresAt time.Time
	// FirstJoin is true when this redemption materialized the guest (vs a
	// link reuse). The join endpoint pushes member_added to the room's
	// members exactly once, on first join -- without it their clients show
	// the guest's messages under a UUID stub until the next reconnect.
	FirstJoin bool
}

// RedeemEphemeralInvite materializes the guest (first use) or refreshes its
// display name (reuse), then mints a session. Returns ErrNotFound /
// ErrInviteRevoked / ErrInviteExpired for the respective dead ends; a
// vanished or expired channel is ErrInviteExpired too, because to the guest
// that is what it means.
func (s *Store) RedeemEphemeralInvite(ctx context.Context, in RedeemInput) (RedeemedGuest, error) {
	displayName := strings.TrimSpace(in.DisplayName)
	if displayName == "" {
		return RedeemedGuest{}, errors.New("display name required")
	}
	var out RedeemedGuest
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var inv EphemeralInvite
		qerr := tx.QueryRow(ctx,
			`SELECT channel_id, created_by, guest_user_id, x25519_pub, ed25519_pub, self_sig,
			        key_version, wrap_suite, wrap_blob, expires_at, redeemed_at, revoked_at
			   FROM ephemeral_invites WHERE lookup = $1 FOR UPDATE`,
			in.Lookup,
		).Scan(&inv.ChannelID, &inv.CreatedBy, &inv.GuestUserID, &inv.X25519Pub, &inv.Ed25519Pub, &inv.SelfSig,
			&inv.KeyVersion, &inv.WrapSuite, &inv.WrapBlob, &inv.ExpiresAt, &inv.RedeemedAt, &inv.RevokedAt)
		if errors.Is(qerr, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if qerr != nil {
			return fmt.Errorf("load invite: %w", qerr)
		}
		now := time.Now().UTC()
		if inv.RevokedAt != nil {
			return ErrInviteRevoked
		}
		if !inv.ExpiresAt.After(now) {
			return ErrInviteExpired
		}

		var chName string
		var chExpires *time.Time
		qerr = tx.QueryRow(ctx,
			`SELECT name, expires_at FROM channels WHERE id = $1`, inv.ChannelID,
		).Scan(&chName, &chExpires)
		if errors.Is(qerr, pgx.ErrNoRows) {
			return ErrInviteExpired // room already purged
		}
		if qerr != nil {
			return fmt.Errorf("load channel: %w", qerr)
		}
		if chExpires == nil || !chExpires.After(now) {
			return ErrInviteExpired
		}

		var exists bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM users WHERE id = $1)`, inv.GuestUserID,
		).Scan(&exists); err != nil {
			return fmt.Errorf("probe guest: %w", err)
		}
		if !exists {
			// First redemption: materialize the principal. The handle
			// satisfies the users contract (UNIQUE, ^[a-z0-9_]{3,32}$) and is
			// never shown as the guest's name -- display_name is (80-14).
			tag := "guest_" + strings.ReplaceAll(inv.GuestUserID.String(), "-", "")[:12]
			if _, err := tx.Exec(ctx,
				`INSERT INTO users (id, handle, username, display_name, email, guest_channel_id)
				 VALUES ($1, $2::text::citext, $2::text::citext, $3, $2::text || '@guest.invalid', $4)`,
				inv.GuestUserID, tag, displayName, inv.ChannelID,
			); err != nil {
				return fmt.Errorf("insert guest user: %w", err)
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO ephemeral_guests (user_id, channel_id, invite_lookup)
				 VALUES ($1, $2, $3)`,
				inv.GuestUserID, inv.ChannelID, in.Lookup,
			); err != nil {
				return fmt.Errorf("insert guest row: %w", err)
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO channel_members (channel_id, user_id, role)
				 VALUES ($1, $2, 'member')`,
				inv.ChannelID, inv.GuestUserID,
			); err != nil {
				return fmt.Errorf("insert membership: %w", err)
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO ephemeral_identity_keys (user_id, x25519_pub, ed25519_pub, self_sig)
				 VALUES ($1, $2, $3, $4)`,
				inv.GuestUserID, inv.X25519Pub, inv.Ed25519Pub, inv.SelfSig,
			); err != nil {
				return fmt.Errorf("insert guest identity: %w", err)
			}
			if _, err := tx.Exec(ctx,
				`INSERT INTO channel_keys (channel_id, key_version, recipient_id, wrap_suite, wrap_blob)
				 VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (channel_id, key_version, recipient_id) DO NOTHING`,
				inv.ChannelID, inv.KeyVersion, inv.GuestUserID, inv.WrapSuite, inv.WrapBlob,
			); err != nil {
				return fmt.Errorf("insert guest key wrap: %w", err)
			}
		} else {
			// Reuse: same identity, freshest typed name wins.
			if _, err := tx.Exec(ctx,
				`UPDATE users SET display_name = $1 WHERE id = $2 AND guest_channel_id = $3`,
				displayName, inv.GuestUserID, inv.ChannelID,
			); err != nil {
				return fmt.Errorf("update guest name: %w", err)
			}
		}

		if _, err := tx.Exec(ctx,
			`UPDATE ephemeral_invites SET redeemed_at = COALESCE(redeemed_at, now())
			  WHERE lookup = $1`,
			in.Lookup,
		); err != nil {
			return fmt.Errorf("mark redeemed: %w", err)
		}

		token, err := NewSessionToken()
		if err != nil {
			return err
		}
		sessExpires := now.Add(in.SessionTTL)
		if in.SessionTTL <= 0 || sessExpires.After(*chExpires) {
			sessExpires = *chExpires
		}
		var uaParam, ipParam any
		if in.UserAgent != "" {
			uaParam = in.UserAgent
		}
		if len(in.IP) > 0 {
			ipParam = in.IP.String()
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO ephemeral_sessions (token, user_id, created_at, last_used_at, expires_at, user_agent, ip_address)
			 VALUES ($1, $2, $3, $3, $4, $5, $6::text::inet)`,
			token, inv.GuestUserID, now, sessExpires, uaParam, ipParam,
		); err != nil {
			return fmt.Errorf("insert guest session: %w", err)
		}

		out = RedeemedGuest{
			FirstJoin:   !exists,
			UserID:      inv.GuestUserID,
			DisplayName: displayName,
			ChannelID:   inv.ChannelID,
			ChannelName: chName,
			OwnerUserID: inv.CreatedBy, // 82-7

			ChannelExpiresAt: *chExpires,
			KeyVersion:       inv.KeyVersion,
			WrapSuite:        inv.WrapSuite,
			WrapBlob:         inv.WrapBlob,
			SessionToken:     token,
			SessionExpiresAt: sessExpires,
		}
		return nil
	})
	if err != nil {
		return RedeemedGuest{}, err
	}
	return out, nil
}

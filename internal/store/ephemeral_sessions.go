package store

// 80-9: guest session resolution. Guest sessions live in ephemeral_sessions
// (0050) -- their own table, so chalk_guest needs no grant on real sessions
// -- but resolution itself runs under the app pool: the token is how the
// guest's identity is LEARNED, so there is nothing to pin the RLS settings
// to yet.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// EphemeralSession is one ephemeral_sessions row joined with the guest's
// identity: who it is, and the ONE channel it exists for.
type EphemeralSession struct {
	UserID         uuid.UUID
	GuestChannelID uuid.UUID
	DisplayName    string
	Handle         string
	CreatedAt      time.Time
	ExpiresAt      time.Time
}

// GetEphemeralSession resolves a guest session token. ErrNotFound for
// unknown AND expired tokens (deliberately merged, like GetSession) -- and
// for the pathological case of a session whose user lost its guest marker.
func (s *Store) GetEphemeralSession(ctx context.Context, token []byte) (EphemeralSession, error) {
	var es EphemeralSession
	err := s.Pool.QueryRow(ctx,
		`SELECT es.user_id, u.guest_channel_id, u.display_name, u.handle::text,
		        es.created_at, es.expires_at
		   FROM ephemeral_sessions es
		   JOIN users u ON u.id = es.user_id
		  WHERE es.token = $1
		    AND es.expires_at > now()
		    AND u.guest_channel_id IS NOT NULL`,
		token,
	).Scan(&es.UserID, &es.GuestChannelID, &es.DisplayName, &es.Handle,
		&es.CreatedAt, &es.ExpiresAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return EphemeralSession{}, ErrNotFound
	}
	if err != nil {
		return EphemeralSession{}, fmt.Errorf("get ephemeral session: %w", err)
	}
	return es, nil
}

// TouchEphemeralSession bumps last_used_at. No sliding TTL: a guest session's
// expiry was clamped to the channel's life at mint time and never extends.
func (s *Store) TouchEphemeralSession(ctx context.Context, token []byte) error {
	_, err := s.Pool.Exec(ctx,
		`UPDATE ephemeral_sessions SET last_used_at = now() WHERE token = $1`, token)
	if err != nil {
		return fmt.Errorf("touch ephemeral session: %w", err)
	}
	return nil
}

// DeleteExpiredEphemeralSessions sweeps expired guest sessions; wired into
// the same hourly janitor as real sessions. Channel purge removes them
// earlier via the users cascade; this catches sessions that expired while
// their room lives on.
func (s *Store) DeleteExpiredEphemeralSessions(ctx context.Context) (int64, error) {
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM ephemeral_sessions WHERE expires_at < now()`)
	if err != nil {
		return 0, fmt.Errorf("delete expired ephemeral sessions: %w", err)
	}
	return tag.RowsAffected(), nil
}

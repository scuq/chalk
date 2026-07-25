package store

import (
	"context"
	"errors"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Phase 33-1: per-user channel read cursors (see migrations/0043).
//
// A cursor is the highest message seq the user has seen in a channel.
// Callers are responsible for the membership check; these functions only
// enforce that the cursor stays monotonic and within the channel's
// assigned seq range.

// markReadSQL raises a cursor, clamped to the channel's last assigned seq
// and never moving backwards. Args: $1 user, $2 channel, $3 requested seq.
//
// Both guards matter. The clamp stops a client that guesses high from
// hiding messages it never saw; the GREATEST stops a stale or reordered
// mark_read from rewinding a cursor another device already advanced.
const markReadSQL = `
	INSERT INTO channel_reads (user_id, channel_id, last_read_seq)
	SELECT $1, $2, LEAST($3::BIGINT, GREATEST(cs.next_seq - 1, 0))
	  FROM channel_seq cs
	 WHERE cs.channel_id = $2
	ON CONFLICT (user_id, channel_id) DO UPDATE
	   SET last_read_seq = GREATEST(channel_reads.last_read_seq, EXCLUDED.last_read_seq),
	       updated_at    = now()
	RETURNING last_read_seq`

// MarkChannelRead raises the user's cursor for a channel to seq and
// returns the effective cursor after the write.
//
// Returns ErrChannelNotFound when the channel has no channel_seq row.
func (s *Store) MarkChannelRead(ctx context.Context, channelID, userID uuid.UUID, seq int64) (int64, error) {
	if seq < 0 {
		seq = 0
	}
	var effective int64
	err := s.Pool.QueryRow(ctx, markReadSQL, userID, channelID, seq).Scan(&effective)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return 0, ErrChannelNotFound
		}
		return 0, err
	}
	return effective, nil
}

// MarkChannelReadTx is MarkChannelRead inside a caller's transaction. Used
// by the send path so a message you just sent is never unread for you --
// including on your other devices after they reconnect, which a
// client-side rule alone would not survive.
func MarkChannelReadTx(ctx context.Context, tx pgx.Tx, channelID, userID uuid.UUID, seq int64) error {
	if seq < 0 {
		seq = 0
	}
	var effective int64
	err := tx.QueryRow(ctx, markReadSQL, userID, channelID, seq).Scan(&effective)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrChannelNotFound
	}
	return err
}

// GetChannelRead returns the user's cursor for one channel. A missing row
// means "never read", which is 0.
func (s *Store) GetChannelRead(ctx context.Context, channelID, userID uuid.UUID) (int64, error) {
	var seq int64
	err := s.Pool.QueryRow(ctx,
		`SELECT last_read_seq FROM channel_reads
		  WHERE user_id = $1 AND channel_id = $2`,
		userID, channelID,
	).Scan(&seq)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	return seq, nil
}

// seedChannelRead marks a channel fully read for a user at the current
// last assigned seq. Called when someone joins a channel that already has
// history, so they start caught up instead of with the whole backlog
// flagged unread. No-op if a cursor already exists (a rejoin keeps the
// old, possibly lower, position rather than silently skipping messages
// the user could still decrypt).
func seedChannelRead(ctx context.Context, tx pgx.Tx, channelID, userID uuid.UUID) error {
	_, err := tx.Exec(ctx,
		`INSERT INTO channel_reads (user_id, channel_id, last_read_seq)
		 SELECT $1, $2, GREATEST(cs.next_seq - 1, 0)
		   FROM channel_seq cs
		  WHERE cs.channel_id = $2
		 ON CONFLICT (user_id, channel_id) DO NOTHING`,
		userID, channelID,
	)
	return err
}

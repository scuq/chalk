package store

// Phase 11c-1 PR 4: buffered MLS Welcomes for offline recipients.
//
// 11b-1 dropped Welcomes silently when the recipient was offline.
// PR 4 buffers them: any Welcome dispatched via mls_commit_bundle
// is also written here, alongside the live fanout. On the
// recipient's next hello, the WS handler drains and pushes them;
// the client acks via mls_welcome_ack which deletes the row.
//
// PK (user_id, channel_id) means at most one pending welcome per
// (user, channel) -- a second welcome for the same pair replaces
// the first (a fresher Welcome reflects more recent group state).

import (
	"context"
	"fmt"

	"github.com/google/uuid"
)

// PendingWelcome is one row from mls_pending_welcomes.
type PendingWelcome struct {
	UserID        uuid.UUID
	ChannelID     uuid.UUID
	MlsGroupID    []byte
	WelcomeBytes  []byte
	SenderUserID  uuid.UUID
}

// InsertPendingWelcome buffers a Welcome for the recipient to
// receive when they next connect. If a row already exists for the
// same (user, channel), it is overwritten (the fresher Welcome
// reflects more recent group state).
//
// Callers should ALSO call FanOutToUser to deliver the welcome to
// any currently-connected device of the recipient; buffering and
// live fanout are independent. The client deduplicates: a Welcome
// for a channel the recipient already has is harmless (CoreCrypto's
// processWelcome returns "already in group" or similar).
func (s *Store) InsertPendingWelcome(
	ctx context.Context,
	userID, channelID uuid.UUID,
	mlsGroupID, welcomeBytes []byte,
	senderUserID uuid.UUID,
) error {
	if len(mlsGroupID) == 0 {
		return fmt.Errorf("mls_group_id must not be empty")
	}
	if len(welcomeBytes) == 0 {
		return fmt.Errorf("welcome_bytes must not be empty")
	}
	if len(welcomeBytes) > 65536 {
		return fmt.Errorf("welcome_bytes exceeds 64KB cap (got %d)", len(welcomeBytes))
	}
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO mls_pending_welcomes
		   (user_id, channel_id, mls_group_id, welcome_bytes, sender_user_id)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (user_id, channel_id) DO UPDATE
		   SET mls_group_id   = EXCLUDED.mls_group_id,
		       welcome_bytes  = EXCLUDED.welcome_bytes,
		       sender_user_id = EXCLUDED.sender_user_id,
		       buffered_at    = NOW()`,
		userID, channelID, mlsGroupID, welcomeBytes, senderUserID,
	)
	if err != nil {
		return fmt.Errorf("insert pending_welcome: %w", err)
	}
	return nil
}

// DrainPendingWelcomesForUser returns all buffered welcomes for the
// given user. It does NOT delete the rows -- they stay buffered
// until the client sends mls_welcome_ack, which triggers
// DeletePendingWelcome.
//
// Why "drain" if we don't delete: the name reflects the operation
// from the WS handler's perspective (it drains the queue at
// connect time). The deletion is deferred to the ack so we don't
// lose welcomes if the client disconnects between drain and
// processing.
//
// Returns an empty slice (not nil) if no welcomes are pending.
func (s *Store) DrainPendingWelcomesForUser(
	ctx context.Context,
	userID uuid.UUID,
) ([]PendingWelcome, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT user_id, channel_id, mls_group_id, welcome_bytes, sender_user_id
		   FROM mls_pending_welcomes
		  WHERE user_id = $1
		  ORDER BY buffered_at ASC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("query pending_welcomes: %w", err)
	}
	defer rows.Close()

	out := make([]PendingWelcome, 0)
	for rows.Next() {
		var w PendingWelcome
		if err := rows.Scan(
			&w.UserID, &w.ChannelID, &w.MlsGroupID,
			&w.WelcomeBytes, &w.SenderUserID,
		); err != nil {
			return nil, fmt.Errorf("scan pending_welcome: %w", err)
		}
		out = append(out, w)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows.Err pending_welcomes: %w", err)
	}
	return out, nil
}

// DeletePendingWelcome removes the buffered welcome for
// (userID, channelID). Called by handleMlsWelcomeAck. Idempotent:
// deleting a non-existent row is a no-op (the user might have
// acked a welcome that was already delivered live, leaving nothing
// buffered).
func (s *Store) DeletePendingWelcome(
	ctx context.Context,
	userID, channelID uuid.UUID,
) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM mls_pending_welcomes
		  WHERE user_id = $1 AND channel_id = $2`,
		userID, channelID,
	)
	if err != nil {
		return fmt.Errorf("delete pending_welcome: %w", err)
	}
	return nil
}

// CountPendingWelcomesForUser returns how many welcomes are
// currently buffered for the user. Diagnostic only; not used by
// the hot path.
func (s *Store) CountPendingWelcomesForUser(
	ctx context.Context,
	userID uuid.UUID,
) (int, error) {
	var n int
	err := s.Pool.QueryRow(ctx,
		`SELECT count(*) FROM mls_pending_welcomes WHERE user_id = $1`,
		userID,
	).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("count pending_welcomes: %w", err)
	}
	return n, nil
}

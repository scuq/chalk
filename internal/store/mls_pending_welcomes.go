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
	"time"

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

// DefaultPendingWelcomeTTL is how long a buffered Welcome may sit
// unacked before the sweep evicts it. A Welcome older than this is
// almost certainly for a recipient who isn't returning, and would
// reference a stale epoch the group has advanced past anyway -- so
// delivering it would likely OrphanWelcome rather than work. An evicted
// recipient who later uses the channel is handled by the phase 11c-6
// split-brain guard (re-add with a fresh Welcome). Phase 11c-8.
const DefaultPendingWelcomeTTL = 14 * 24 * time.Hour

// DeleteStalePendingWelcomes removes buffered welcomes older than
// olderThan. Returns the number of rows deleted. Phase 11c-8.
func (s *Store) DeleteStalePendingWelcomes(
	ctx context.Context,
	olderThan time.Duration,
) (int64, error) {
	// Pass the cutoff as numeric seconds and build the interval with
	// make_interval. Go's Duration.String() (e.g. "336h0m0s") is NOT
	// valid Postgres interval syntax, so we avoid a text cast entirely.
	secs := olderThan.Seconds()
	tag, err := s.Pool.Exec(ctx,
		`DELETE FROM mls_pending_welcomes
		  WHERE buffered_at < NOW() - make_interval(secs => $1)`,
		secs,
	)
	if err != nil {
		return 0, fmt.Errorf("delete stale pending_welcomes: %w", err)
	}
	return tag.RowsAffected(), nil
}

// PendingWelcomeSweepLoop periodically evicts stale buffered welcomes.
// Mirrors PartitionMaintenanceLoop: runs once immediately, then on the
// given interval, until ctx is cancelled. ttl is the eviction age.
// logf may be nil. Phase 11c-8.
func (s *Store) PendingWelcomeSweepLoop(
	ctx context.Context,
	interval time.Duration,
	ttl time.Duration,
	logf func(string, ...any),
) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	sweep := func() {
		n, err := s.DeleteStalePendingWelcomes(ctx, ttl)
		if err != nil {
			logf("pending_welcome sweep: %v", err)
			return
		}
		if n > 0 {
			logf("pending_welcome sweep: evicted %d stale welcome(s) older than %s", n, ttl)
		}
	}
	sweep() // once on startup
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			sweep()
		}
	}
}

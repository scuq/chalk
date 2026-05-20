package store

// Phase 11c-1: stored MLS commits for late-joiner catchup.
//
// In 11b's two-member DMs, every group change was either the
// initial Add (which the Welcome conveys to the joiner) or no change
// at all. There was nothing to catch up: a device that came back
// online would have its single Welcome buffered for it or refetched
// via re-pair.
//
// 11c multi-member channels accumulate a sequence of Commits over
// the channel's lifetime. A device offline between epoch N and N+5
// must replay the four intervening Commits to bring its CoreCrypto
// group state to epoch N+5. We store the opaque Commit bytes at
// the moment they land server-side, then serve them back on demand.
//
// Server-side, the bytes are entirely opaque. We only verify the
// wrapper (epoch, channel_id, sender identity) before insertion.

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MlsCommit is one row from mls_commits.
type MlsCommit struct {
	ChannelID         uuid.UUID
	Epoch             int64
	CommitBytes       []byte
	CommittedByUserID   uuid.UUID
	CommittedByDeviceID uuid.UUID
}

// ErrMlsCommitEpochExists is returned by InsertMlsCommit when a
// commit is already stored for the same (channel_id, epoch). This
// is the server-side detection of a stale-commit race: two clients
// both raced to commit epoch N+1; the first wins, the second sees
// this error and the WS handler returns ErrCodeMlsStaleCommit to
// the client so it retries against the new epoch.
var ErrMlsCommitEpochExists = errors.New("mls commit already stored for this (channel, epoch)")

// InsertMlsCommit stores a Commit for late-joiner catchup. The
// (channel_id, epoch) is the PK; if a different Commit is already
// stored for that pair, returns ErrMlsCommitEpochExists. The caller
// is the WS handler; it surfaces the race to the client as
// ErrCodeMlsStaleCommit.
//
// Implementation: read-then-write inside a transaction with a
// fallback for the racing-insert case. We SELECT first to handle
// the common idempotent retry path (same sender posts identical
// bytes after a network blip). On ErrNoRows we INSERT, but two
// concurrent racers can both observe ErrNoRows under PG's default
// READ COMMITTED -- so the INSERT itself can violate the PK. When
// that happens, we re-SELECT and apply the same idempotent-retry
// vs. race-loser logic.
func (s *Store) InsertMlsCommit(
	ctx context.Context,
	channelID uuid.UUID,
	epoch int64,
	commitBytes []byte,
	committedByUserID uuid.UUID,
	committedByDeviceID uuid.UUID,
) error {
	if epoch < 0 {
		return fmt.Errorf("epoch must be non-negative, got %d", epoch)
	}
	if len(commitBytes) == 0 {
		return fmt.Errorf("commit_bytes must not be empty")
	}
	if len(commitBytes) > 65536 {
		return fmt.Errorf("commit_bytes exceeds 64KB cap (got %d)", len(commitBytes))
	}

	return s.withTx(ctx, func(tx pgx.Tx) error {
		// Helper: decide whether an already-stored row at (channel,
		// epoch) is an idempotent retry or a real race-loss.
		decideExisting := func(existing []byte, existingUserID uuid.UUID) error {
			if existingUserID == committedByUserID && bytesEqual(existing, commitBytes) {
				return nil // idempotent retry
			}
			return ErrMlsCommitEpochExists
		}

		var existing []byte
		var existingUserID uuid.UUID
		err := tx.QueryRow(ctx,
			`SELECT commit_bytes, committed_by_user_id
			   FROM mls_commits
			  WHERE channel_id = $1 AND epoch = $2`,
			channelID, epoch,
		).Scan(&existing, &existingUserID)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			// Try insert. May race-lose to a concurrent inserter.
			_, insErr := tx.Exec(ctx,
				`INSERT INTO mls_commits
				   (channel_id, epoch, commit_bytes,
				    committed_by_user_id, committed_by_device_id)
				 VALUES ($1, $2, $3, $4, $5)`,
				channelID, epoch, commitBytes,
				committedByUserID, committedByDeviceID,
			)
			if insErr == nil {
				return nil
			}
			// PG unique-violation. Chalk's existing convention (see
			// internal/store/admin_bootstrap.go::isUniqueViolation)
			// is to match on error text rather than depend on pgconn
			// SQLSTATE, to stay decoupled from pgx version specifics.
			if !isMlsUniqueViolation(insErr) {
				return fmt.Errorf("insert mls_commit: %w", insErr)
			}
			// Race-loss: someone else inserted between our SELECT and
			// INSERT. Re-read and decide.
			if err := tx.QueryRow(ctx,
				`SELECT commit_bytes, committed_by_user_id
				   FROM mls_commits
				  WHERE channel_id = $1 AND epoch = $2`,
				channelID, epoch,
			).Scan(&existing, &existingUserID); err != nil {
				return fmt.Errorf("re-read after PK violation: %w", err)
			}
			return decideExisting(existing, existingUserID)
		case err != nil:
			return fmt.Errorf("lookup existing mls_commit: %w", err)
		}
		// Row exists. Same sender + same bytes = idempotent retry;
		// otherwise race-loss.
		return decideExisting(existing, existingUserID)
	})
}

// ListMlsCommitsSince returns all stored commits for a channel
// with epoch strictly greater than afterEpoch, in ascending epoch
// order. Used by the WS catchup handler when a reconnecting device's
// known-epoch lags the channel's current epoch.
//
// Returns an empty slice (not nil) if no commits match. Caller
// should pass afterEpoch = the device's known epoch; commits at
// epoch > afterEpoch are exactly those the device has not yet
// processed.
//
// Limit: the catchup is unbounded by design. If a device has been
// offline for a year and its channel changed every day, this
// returns ~365 rows. Each row is ~2-8KB of opaque bytes; one MB
// in the worst case. The caller (WS handler) streams these as
// individual mls_commit_event push frames, not a single response.
func (s *Store) ListMlsCommitsSince(
	ctx context.Context,
	channelID uuid.UUID,
	afterEpoch int64,
) ([]MlsCommit, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT channel_id, epoch, commit_bytes,
		        committed_by_user_id, committed_by_device_id
		   FROM mls_commits
		  WHERE channel_id = $1 AND epoch > $2
		  ORDER BY epoch ASC`,
		channelID, afterEpoch,
	)
	if err != nil {
		return nil, fmt.Errorf("query mls_commits: %w", err)
	}
	defer rows.Close()

	out := make([]MlsCommit, 0)
	for rows.Next() {
		var c MlsCommit
		if err := rows.Scan(
			&c.ChannelID, &c.Epoch, &c.CommitBytes,
			&c.CommittedByUserID, &c.CommittedByDeviceID,
		); err != nil {
			return nil, fmt.Errorf("scan mls_commit: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows.Err mls_commits: %w", err)
	}
	return out, nil
}

// GetMlsCommitAt returns the commit stored for (channelID, epoch),
// or nil if no commit is stored at that epoch. Useful for the WS
// handler's response to a targeted "give me commit at epoch N"
// request from a client that's almost caught up.
func (s *Store) GetMlsCommitAt(
	ctx context.Context,
	channelID uuid.UUID,
	epoch int64,
) (*MlsCommit, error) {
	var c MlsCommit
	err := s.Pool.QueryRow(ctx,
		`SELECT channel_id, epoch, commit_bytes,
		        committed_by_user_id, committed_by_device_id
		   FROM mls_commits
		  WHERE channel_id = $1 AND epoch = $2`,
		channelID, epoch,
	).Scan(
		&c.ChannelID, &c.Epoch, &c.CommitBytes,
		&c.CommittedByUserID, &c.CommittedByDeviceID,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get mls_commit: %w", err)
	}
	return &c, nil
}

// isMlsUniqueViolation matches pgx's unique-constraint error text.
// Mirrors internal/store/admin_bootstrap.go::isUniqueViolation; kept
// local rather than promoted to a shared helper so the two callers
// remain trivially greppable. If a third call site appears, promote.
func isMlsUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	msg := err.Error()
	return strings.Contains(msg, "unique") || strings.Contains(msg, "duplicate")
}

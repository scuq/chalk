package store

// 80-4: hard deletion of a whole channel, and the janitor that applies it to
// expired ephemeral channels (docs/PHASE-80-EPHEMERAL.md).
//
// Cascade cannot do this: messages is partitioned and its channel linkage is
// application-enforced (0003), and attachments declares channel_id with no FK
// at all (0037) -- so `DELETE FROM channels` would leave every message and
// attachment behind, still holding ciphertext, unreachable. PurgeChannel
// extends the explicit ordering PurgeVoiceScratchIfEmpty already proves out,
// then lets the channel-row delete cascade the rest (members, keys, seq,
// reads, invites, voice occupancy, thread/reaction/ack rows via their
// composite FKs into messages -- and the guest principals themselves, via
// users.guest_channel_id ON DELETE CASCADE).
//
// Governance rows go FIRST and explicitly: proposals.created_by and
// proposal_votes.voter_id reference users(id) with NO ACTION (0036), and the
// order in which one statement's cascades fire is not something to bet a
// janitor on -- a guest row deleted before a vote row that names it would
// abort the whole purge.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// PurgeChannelStats reports what a purge removed -- counts for the operator
// log, and the membership snapshot (captured before the delete) for the
// 80-14 aftermath: real members get the channel_event{kind:"deleted"} push,
// guest connections get closed outright (their world ended).
type PurgeChannelStats struct {
	Messages    int64
	Attachments int64
	Guests      int64
	// MemberIDs are the REAL members at purge time; GuestIDs the guests.
	MemberIDs []uuid.UUID
	GuestIDs  []uuid.UUID
}

// PurgeChannel hard-deletes a channel and everything it held, in one
// transaction. Returns ErrNotFound if the channel does not exist (e.g. a
// second janitor instance won the race; the FOR UPDATE lock makes that
// unambiguous). It works on any channel -- the expiry janitor and the
// chalkctl operator path (80-11) share it.
func (s *Store) PurgeChannel(ctx context.Context, channelID uuid.UUID) (PurgeChannelStats, error) {
	var st PurgeChannelStats
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var createdAt time.Time
		qerr := tx.QueryRow(ctx,
			`SELECT created_at FROM channels WHERE id = $1 FOR UPDATE`,
			channelID,
		).Scan(&createdAt)
		if errors.Is(qerr, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if qerr != nil {
			return fmt.Errorf("lock channel: %w", qerr)
		}

		for _, del := range []string{
			`DELETE FROM proposal_votes
			  WHERE proposal_id IN (SELECT id FROM proposals WHERE channel_id = $1)`,
			`DELETE FROM proposal_eligibility
			  WHERE proposal_id IN (SELECT id FROM proposals WHERE channel_id = $1)`,
			`DELETE FROM proposals WHERE channel_id = $1`,
			`DELETE FROM attachment_chunks
			  WHERE attachment_id IN (SELECT id FROM attachments WHERE channel_id = $1)`,
			`DELETE FROM thread_reads WHERE channel_id = $1`,
		} {
			if _, derr := tx.Exec(ctx, del, channelID); derr != nil {
				return fmt.Errorf("purge channel %s: %w", channelID, derr)
			}
		}

		tag, derr := tx.Exec(ctx,
			`DELETE FROM attachments WHERE channel_id = $1`, channelID)
		if derr != nil {
			return fmt.Errorf("purge attachments: %w", derr)
		}
		st.Attachments = tag.RowsAffected()

		// The ts bound prunes the delete to the partitions the channel could
		// have written (creation month onward) instead of probing every
		// monthly partition in the database.
		tag, derr = tx.Exec(ctx,
			`DELETE FROM messages WHERE channel_id = $1 AND ts >= $2`,
			channelID, createdAt)
		if derr != nil {
			return fmt.Errorf("purge messages: %w", derr)
		}
		st.Messages = tag.RowsAffected()

		// Snapshot the roster before the channel row goes -- the delete
		// below takes memberships (and the guest users rows, via
		// users.guest_channel_id CASCADE) with it.
		rows, derr := tx.Query(ctx,
			`SELECT cm.user_id, u.guest_channel_id IS NOT NULL
			   FROM channel_members cm
			   JOIN users u ON u.id = cm.user_id
			  WHERE cm.channel_id = $1`,
			channelID)
		if derr != nil {
			return fmt.Errorf("snapshot members: %w", derr)
		}
		for rows.Next() {
			var uid uuid.UUID
			var isGuest bool
			if err := rows.Scan(&uid, &isGuest); err != nil {
				rows.Close()
				return fmt.Errorf("snapshot members: %w", err)
			}
			if isGuest {
				st.GuestIDs = append(st.GuestIDs, uid)
			} else {
				st.MemberIDs = append(st.MemberIDs, uid)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return fmt.Errorf("snapshot members: %w", err)
		}
		st.Guests = int64(len(st.GuestIDs))

		if _, derr := tx.Exec(ctx,
			`DELETE FROM channels WHERE id = $1`, channelID); derr != nil {
			return fmt.Errorf("purge channel row: %w", derr)
		}
		return nil
	})
	if err != nil {
		return PurgeChannelStats{}, err
	}
	return st, nil
}

// ListExpiredChannels returns the ids of channels whose expires_at has
// passed. Uses the channels_expiry_idx partial index; permanent channels
// (expires_at IS NULL) are never candidates.
func (s *Store) ListExpiredChannels(ctx context.Context, now time.Time) ([]uuid.UUID, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT id FROM channels WHERE expires_at IS NOT NULL AND expires_at <= $1`,
		now)
	if err != nil {
		return nil, fmt.Errorf("list expired channels: %w", err)
	}
	defer rows.Close()
	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("list expired channels: %w", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("list expired channels: %w", err)
	}
	return out, nil
}

// EphemeralJanitorLoop purges expired ephemeral channels once immediately and
// then every interval until ctx is canceled, in the VoiceJanitorLoop style:
// errors are logged, never fatal, and one broken channel does not stop the
// sweep -- the narrowed DM trigger (0050) exists so a fault elsewhere cannot
// wedge this loop either. onPurged (optional) is handed each purged channel
// so the server can push the deletion to connected clients and kick a live
// call (wired in 80-14).
func (s *Store) EphemeralJanitorLoop(
	ctx context.Context,
	interval time.Duration,
	onPurged func(uuid.UUID, PurgeChannelStats),
	logf func(string, ...any),
) {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	if interval <= 0 {
		interval = time.Minute
	}
	sweep := func() {
		cctx, cancel := context.WithTimeout(ctx, time.Minute)
		defer cancel()
		ids, err := s.ListExpiredChannels(cctx, time.Now().UTC())
		if err != nil {
			logf("ephemeral janitor: %v", err)
			return
		}
		for _, id := range ids {
			stats, err := s.PurgeChannel(cctx, id)
			if errors.Is(err, ErrNotFound) {
				continue // another instance purged it first
			}
			if err != nil {
				logf("ephemeral janitor: purge %s: %v", id, err)
				continue
			}
			logf("ephemeral janitor: purged expired channel %s (%d messages, %d attachments, %d guests)",
				id, stats.Messages, stats.Attachments, stats.Guests)
			if onPurged != nil {
				onPurged(id, stats)
			}
		}
	}
	sweep()
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sweep()
		}
	}
}

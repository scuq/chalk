package store

// Voice-channel scratchpad purge (Phase 45, slice 45-1).
//
// A voice channel's text is a SCRATCHPAD, not a log: it exists for the
// duration of a call and is destroyed when the call is. The moment the room
// empties, everything anyone typed in it goes -- from the server, and (via the
// voice_purged push) from every connected client.
//
// This is a HARD delete, not the tombstone DeleteMessage writes: a tombstone
// is for "this one message was retracted, and the retraction is itself a fact
// members should see". Nothing survives a call here, so there is nothing to
// tell anyone about afterwards.

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// PurgeVoiceScratchIfEmpty deletes every message and attachment in a voice
// channel, but only if its live room is empty. Returns whether it purged and
// how many message rows went with it.
//
// The channel row is locked FOR UPDATE first, which is the same lock JoinVoice
// takes: a join racing the last leave either lands before the lock (and the
// occupancy count here sees it, so nothing is purged under a live call) or
// after it (and joins an already-purged room). Without the lock, a purge could
// commit between "count says empty" and someone's first message.
//
// A non-voice channel is never touched -- text channels keep their history.
//
// What goes:
//   - messages (cascades message_reactions, message_acks and thread_activity
//     via their composite FKs into messages)
//   - attachments and their staged chunks (no FK from chunks; deleted first,
//     exactly as DeleteOrphanedUploads does it)
//   - thread_reads rows for the channel: threads are gone, and thread_reads
//     deliberately has NO FK into messages (0047), so they would dangle
//
// What stays: channel_seq. Sequence numbers keep climbing across a purge, so
// the next call's messages sort after this one's.
//
// channel_reads cursors are ADVANCED to the channel's current seq, for every
// member and not just the ones who were in the room. Nothing is left to read,
// so nobody may be told there is: a cursor left behind would put an unread dot
// on an empty channel, and because channel_seq never rewinds that dot would
// survive every reconnect until the member opened a channel with nothing in it.
func (s *Store) PurgeVoiceScratchIfEmpty(
	ctx context.Context,
	channelID uuid.UUID,
) (purged bool, messages int64, err error) {
	err = s.withTx(ctx, func(tx pgx.Tx) error {
		var chType string
		qerr := tx.QueryRow(ctx,
			`SELECT channel_type FROM channels WHERE id = $1 FOR UPDATE`,
			channelID,
		).Scan(&chType)
		if errors.Is(qerr, pgx.ErrNoRows) {
			return nil // channel is gone; its rows went with it
		}
		if qerr != nil {
			return fmt.Errorf("lock channel: %w", qerr)
		}
		if chType != "voice" {
			return nil
		}

		var occupied int
		if qerr := tx.QueryRow(ctx,
			`SELECT count(*) FROM voice_participants WHERE channel_id = $1`,
			channelID,
		).Scan(&occupied); qerr != nil {
			return fmt.Errorf("occupancy: %w", qerr)
		}
		if occupied > 0 {
			return nil
		}

		if _, derr := tx.Exec(ctx,
			`DELETE FROM attachment_chunks
			  WHERE attachment_id IN (SELECT id FROM attachments WHERE channel_id = $1)`,
			channelID,
		); derr != nil {
			return fmt.Errorf("purge attachment chunks: %w", derr)
		}
		if _, derr := tx.Exec(ctx,
			`DELETE FROM attachments WHERE channel_id = $1`, channelID,
		); derr != nil {
			return fmt.Errorf("purge attachments: %w", derr)
		}
		if _, derr := tx.Exec(ctx,
			`DELETE FROM thread_reads WHERE channel_id = $1`, channelID,
		); derr != nil {
			return fmt.Errorf("purge thread reads: %w", derr)
		}
		tag, derr := tx.Exec(ctx, `DELETE FROM messages WHERE channel_id = $1`, channelID)
		if derr != nil {
			return fmt.Errorf("purge messages: %w", derr)
		}
		if _, derr := tx.Exec(ctx,
			`INSERT INTO channel_reads (user_id, channel_id, last_read_seq)
			 SELECT cm.user_id, $1, GREATEST(COALESCE(cs.next_seq, 1) - 1, 0)
			   FROM channel_members cm
			   LEFT JOIN channel_seq cs ON cs.channel_id = $1
			  WHERE cm.channel_id = $1
			 ON CONFLICT (user_id, channel_id) DO UPDATE
			    SET last_read_seq = GREATEST(channel_reads.last_read_seq, EXCLUDED.last_read_seq),
			        updated_at    = now()`,
			channelID,
		); derr != nil {
			return fmt.Errorf("mark purged scratchpad read: %w", derr)
		}
		purged = true
		messages = tag.RowsAffected()
		return nil
	})
	if err != nil {
		return false, 0, err
	}
	return purged, messages, nil
}

package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// DefaultChannelID is the placeholder channel that EnsureDefaultChannel
// creates on chalkd startup. Phase 05 uses it as the destination for every
// message; phase 08 replaces this single global channel with proper
// user-created channels.
var DefaultChannelID = uuid.MustParse("00000000-0000-0000-0000-000000000c01")

// Message is one row of the messages table.
type Message struct {
	ID             uuid.UUID
	ChannelID      uuid.UUID
	ThreadID       *uuid.UUID
	ParentID       *uuid.UUID
	SenderDeviceID uuid.UUID
	// Phase 9.6i: the user_id that owns SenderDeviceID at
	// fetch time. uuid.Nil when the device or its owning user
	// has been purged (CASCADE wipes both). Used by the WS
	// handler to populate MessagePayload.SenderUserID.
	SenderUserID uuid.UUID
	Seq          int64
	TS           time.Time
	DeliveredAt  *time.Time
	Body         []byte
	// Phase 23d: message-suite key version. nil = legacy plaintext;
	// >=1 = encrypted body. Carried through to MessagePayload.
	KeyVersion *int
	// Phase 10a: only populated by ListMessagesByChannel (which
	// JOINs the reply-count subquery). GetMessage and other lookups
	// leave this as 0. Callers should treat 0 as "unknown" unless
	// they got the row from the main-feed query.
	ReplyCount int64
	// Phase 10d: highest seq among the thread's replies. Same population
	// rules as ReplyCount. Used client-side to compute "unread" badges
	// (a reply is unread when last_reply_seq > thread_seen[tid]).
	LastReplySeq int64
	// Phase 10e: preview of the most recent reply. Same population
	// rules. *uuid.UUID because the device's user might have been
	// purged; in that case sender_user_id is nil but the body still
	// got stored.
	LastReplySenderUserID *uuid.UUID
	LastReplyBody         []byte
	// Phase 23d: the last reply's message-suite key version, so the client can
	// decrypt the thread preview the same way it decrypts the main feed. nil =
	// legacy/none.
	LastReplyKeyVersion *int
	// Phase 26 (governance prereq): soft-delete tombstone. DeletedAt is
	// non-nil once a message has been deleted (the scrub time); the body is
	// then an empty bytea and KeyVersion is nil. DeletedBy is the user_id
	// that performed the deletion (owner, in dictator mode). Both nil for a
	// live message. Populated by GetMessage and the List* feed queries so
	// clients can render a tombstone instead of decrypting an empty body.
	DeletedAt *time.Time
	DeletedBy *uuid.UUID
	// Phase 37-1: in-place edit stamp. Non-nil once the sender has replaced
	// the body; Seq and TS are unchanged by an edit, so an edited message
	// keeps its place in history. Populated by GetMessage and the List* feed
	// queries so clients can render an "(edited)" marker.
	EditedAt *time.Time
	// Phase 42-3: the VIEWER's thread state for this row, only meaningful on a
	// thread head and only populated by ListMessagesByChannel (which joins
	// thread_reads for the caller). ThreadLastReadSeq is their read high-water
	// mark among this thread's replies -- a reply is unread when
	// LastReplySeq > ThreadLastReadSeq. ThreadInvolved is whether they wrote
	// the head or any reply.
	//
	// These ride along with the row so the client never needs a bulk cursor
	// sync; see the comment on the query.
	ThreadLastReadSeq int64
	ThreadInvolved    bool
}

// ErrMessageNotFound is returned by DeleteMessage when no row matches
// (ts, id, channel_id). Distinct from ErrAlreadyDeleted so the handler can
// tell "you targeted a message that isn't here" from "already a tombstone".
var ErrMessageNotFound = errors.New("message not found")

// ErrAlreadyDeleted is returned by DeleteMessage when the target row exists
// but is already a tombstone. The handler treats this as idempotent success
// (ack, no second push) rather than an error to the user.
var ErrAlreadyDeleted = errors.New("message already deleted")

// InsertMessage persists a message and allocates a per-channel sequence
// number atomically. Returns the persisted Message including its Seq, TS,
// and (server-generated) ID if not supplied.
//
// Concurrency: the per-channel sequence advances in the same transaction as
// the INSERT, which means under heavy contention many writers serialize on
// the channel_seq row. That's acceptable: chat messages within a single
// channel are not high-throughput. If we ever needed >1k msg/s per channel
// (we won't), we'd switch to a Postgres SEQUENCE and accept gaps.
func (s *Store) InsertMessage(ctx context.Context, m Message) (Message, error) {
	if m.ID == uuid.Nil {
		m.ID = uuid.New()
	}
	if m.ChannelID == uuid.Nil {
		return Message{}, fmt.Errorf("InsertMessage: channel_id required")
	}
	if m.SenderDeviceID == uuid.Nil {
		return Message{}, fmt.Errorf("InsertMessage: sender_device_id required")
	}

	err := s.withTx(ctx, func(tx pgx.Tx) error {
		// Allocate seq. UPDATE ... RETURNING + ON CONFLICT DO NOTHING on
		// a no-row case: if the channel_seq row is missing, we have a
		// schema bug; we'd rather fail loudly than auto-create here.
		var seq int64
		err := tx.QueryRow(ctx,
			`UPDATE channel_seq SET next_seq = next_seq + 1
			   WHERE channel_id = $1
			 RETURNING next_seq - 1`,
			m.ChannelID,
		).Scan(&seq)
		if err != nil {
			return fmt.Errorf("allocate seq: %w", err)
		}
		m.Seq = seq

		row := tx.QueryRow(ctx,
			`INSERT INTO messages
			   (id, channel_id, thread_id, parent_id, sender_device_id,
			    seq, body, meta)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, '{}'::jsonb)
			 RETURNING ts`,
			m.ID, m.ChannelID, m.ThreadID, m.ParentID, m.SenderDeviceID,
			m.Seq, m.Body,
		)
		if err := row.Scan(&m.TS); err != nil {
			return err
		}
		// 42-2: the same thread bookkeeping the WS send handler does. This path
		// is test-only today, so leaving it out would make the tests describe a
		// database production never produces.
		//
		// Unlike handleSend this still does not advance the channel cursor and
		// does not publish -- a pre-existing asymmetry, deliberately untouched.
		if m.ParentID != nil && m.ThreadID != nil {
			if err := RecordThreadReplyTx(ctx, tx, m.ChannelID, *m.ThreadID, m.ID, m.SenderDeviceID, m.TS, m.Seq); err != nil {
				return err
			}
		}
		// 62-1: unconditional, unlike the reply-only thread bookkeeping --
		// every message advances its channel's newest-activity pointer.
		return RecordChannelActivityTx(ctx, tx, m.ChannelID, m.ID, m.SenderDeviceID, m.TS, m.Seq)
	})
	if err != nil {
		return Message{}, fmt.Errorf("insert message: %w", err)
	}
	return m, nil
}

// messageSelect is the column list + joins shared by the two single-row
// lookups below. They differ only in how they match ts, and keeping the
// projection in one place keeps the three-site rule (columns / struct fields /
// scan args) to a single site to check.
//
// Phase 9.6i: LEFT JOIN devices so the WS handler can pass sender_user_id to
// clients (for username rendering). devices may be missing (purged), in which
// case user_id comes back NULL and SenderUserID stays uuid.Nil.
const messageSelect = `
	SELECT m.id, m.channel_id, m.thread_id, m.parent_id,
	       m.sender_device_id, d.user_id,
	       m.seq, m.ts, m.delivered_at, m.body, m.key_version,
	       m.deleted_at, m.deleted_by, m.edited_at
	  FROM messages m
	  LEFT JOIN devices d ON d.id = m.sender_device_id
	 WHERE `

func scanMessage(row pgx.Row) (Message, error) {
	var m Message
	var senderUser *uuid.UUID
	err := row.Scan(
		&m.ID, &m.ChannelID, &m.ThreadID, &m.ParentID,
		&m.SenderDeviceID, &senderUser,
		&m.Seq, &m.TS, &m.DeliveredAt, &m.Body, &m.KeyVersion,
		&m.DeletedAt, &m.DeletedBy, &m.EditedAt,
	)
	if senderUser != nil {
		m.SenderUserID = *senderUser
	}
	return m, translateErr(err)
}

// GetMessage fetches a message by its EXACT (ts, id). Both fields are required
// because the messages table is partitioned by ts.
//
// The ts must be full precision, which in practice means it came from another
// store call or from a pubsub event -- NOT off the wire. Wire timestamps are
// unix-millis while messages.ts is microsecond-precision TIMESTAMPTZ, so an
// exact match against a wire ts finds nothing. Use GetMessageAtWireTS for that.
func (s *Store) GetMessage(ctx context.Context, ts time.Time, id uuid.UUID) (Message, error) {
	return scanMessage(s.Pool.QueryRow(ctx,
		messageSelect+`m.ts = $1 AND m.id = $2`, ts, id))
}

// GetMessageAtWireTS fetches a message using a ts that came off the wire in
// unix-millis.
//
// The wire carries ts as unix-millis (MessagePayload.TS is m.TS.UnixMilli()),
// but messages.ts is microsecond-precision, so `ts = $1` against a wire value
// matches nothing at all -- not "usually", never, unless a message happened to
// land exactly on a millisecond boundary. This matches the millis-floored ts
// as a half-open 1ms range [ts, ts+1ms), which contains exactly the original
// row, and which also preserves partition pruning (the table is
// range-partitioned on ts). Same window DeleteMessage and EditMessage use.
//
// Returns the row with its FULL-precision TS, which is what callers need for
// anything that then writes (message_reactions carries the message ts in its
// composite FK) or publishes (the pubsub listener re-fetches by exact ts).
func (s *Store) GetMessageAtWireTS(ctx context.Context, wireTS time.Time, id uuid.UUID) (Message, error) {
	return scanMessage(s.Pool.QueryRow(ctx,
		messageSelect+`m.id = $2
		   AND m.ts >= $1 AND m.ts < $1 + interval '1 millisecond'`, wireTS, id))
}

// DeleteMessage soft-deletes a message: it scrubs the body to an empty bytea,
// nulls key_version, and stamps deleted_at = now() + deleted_by = deleterID,
// all in one transaction. The row is KEPT (a tombstone) so the channel seq
// ordering and any thread hanging off this message survive; clients render a
// "message deleted" placeholder rather than decrypting an empty body.
//
// TS-MATCH PRECISION: the wire carries a message's ts in unix-millis, but the
// stored messages.ts is microsecond-precision TIMESTAMPTZ, so `ts = $1` would
// miss. We match the millis-floored ts as a half-open 1ms range
// [ts, ts+1ms) -- which contains exactly the original row -- AND on id +
// channel_id. The ts range also keeps partition pruning (the table is
// range-partitioned on ts), so this isn't an all-partition scan. RETURNING
// ts hands back the FULL-precision timestamp the listener needs to re-fetch
// the tombstone via GetMessage for the push.
//
// channelID is matched too, so a caller can't scrub a message by guessing its
// id alone -- the (id, channel_id) pair plus the ts window must line up.
//
// Returns the tombstoned row (ID, ChannelID, Seq, TS, DeletedAt, DeletedBy
// populated) so the handler can build the message_deleted push without a
// second query. Errors:
//   - ErrAlreadyDeleted: the row exists but is already a tombstone (idempotent;
//     the handler acks without re-publishing).
//   - ErrMessageNotFound: no row for (ts-window, id, channel_id).
//
// SECURITY NOTE: this is a server-side scrub, not guaranteed erasure. Any
// member who already decrypted the message holds the plaintext on their own
// device; deletion removes it from the server and best-effort tombstones it on
// connected clients, the same forward boundary as removal/revocation.
func (s *Store) DeleteMessage(
	ctx context.Context,
	ts time.Time,
	id, channelID, deleterID uuid.UUID,
) (Message, error) {
	var m Message
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		// The WHERE includes deleted_at IS NULL so a re-delete affects zero
		// rows (idempotency). RETURNING gives us what the push needs.
		row := tx.QueryRow(ctx,
			`UPDATE messages
			    SET body = ''::bytea,
			        key_version = NULL,
			        deleted_at = now(),
			        deleted_by = $4
			  WHERE id = $2 AND channel_id = $3
			    AND ts >= $1 AND ts < $1 + interval '1 millisecond'
			    AND deleted_at IS NULL
			 RETURNING channel_id, seq, ts, deleted_at, deleted_by`,
			ts, id, channelID, deleterID,
		)
		if err := row.Scan(&m.ChannelID, &m.Seq, &m.TS, &m.DeletedAt, &m.DeletedBy); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// Zero rows updated: either the message doesn't exist in this
				// (ts-window, id, channel_id), or it's already a tombstone.
				// Distinguish so the handler can ack-idempotently vs. error.
				var exists bool
				if e2 := tx.QueryRow(ctx,
					`SELECT EXISTS(
					   SELECT 1 FROM messages
					    WHERE id = $2 AND channel_id = $3
					      AND ts >= $1 AND ts < $1 + interval '1 millisecond'
					 )`,
					ts, id, channelID,
				).Scan(&exists); e2 != nil {
					return e2
				}
				if exists {
					return ErrAlreadyDeleted
				}
				return ErrMessageNotFound
			}
			return err
		}
		m.ID = id
		// Phase 37-4: reactions go with the body. Leaving them would keep
		// "who reacted to this, and with what (for anyone holding the key)"
		// on the server for content that is supposed to be gone from it.
		// Same transaction as the tombstone: both or neither.
		if err := ScrubReactionsForMessageTx(ctx, tx, m.TS, id); err != nil {
			return err
		}
		// 83-3: revisions go with the body too, or the tombstone's "the
		// ciphertext is gone from the server" would be silently false --
		// exactly the objection 0044 raised against a revision table, and the
		// reason the purge lives in this transaction. (The FK cascade only
		// fires on real DELETEs; the tombstone is an UPDATE.)
		return PurgeRevisionsForMessageTx(ctx, tx, m.TS, id)
	})
	if err != nil {
		return Message{}, err
	}
	return m, nil
}

// EditMessage replaces a message's body in place and stamps edited_at. The
// new body is ciphertext the caller re-encrypted under keyVersion; the server
// never sees either version in the clear, so an edit is opaque to it beyond
// "this row's bytes changed".
//
// WHAT DOES NOT MOVE: seq and ts are untouched. seq is the per-channel
// ordering every client agrees on, so an edited message must keep its place
// in history; ts is the partition key, so changing it would move the row
// between partitions. Only body, key_version and edited_at change.
//
// The ts match uses the same half-open 1ms window as DeleteMessage -- the
// wire carries unix-millis while messages.ts is microsecond-precision, and
// the range keeps partition pruning alive. channel_id is matched too, so a
// caller can't reach a message by guessing its id alone.
//
// deleted_at IS NULL in the WHERE means an edit can never resurrect a
// tombstoned message: the scrub wins permanently. That case is reported as
// ErrAlreadyDeleted rather than ErrMessageNotFound so the handler can say
// something truthful.
//
// AUTHORIZATION IS THE CALLER'S JOB. This primitive does not check who is
// editing or how old the message is -- handleEditMessage enforces
// sender-only and the edit window before calling. Keeping the policy in the
// handler matches DeleteMessage, whose governance rules live there too.
//
// Returns the updated row (ID, ChannelID, Seq, TS, EditedAt populated) so the
// handler can build the message_edited push without a second query. Errors:
//   - ErrAlreadyDeleted: the row exists but is a tombstone.
//   - ErrMessageNotFound: no row for (ts-window, id, channel_id).
func (s *Store) EditMessage(
	ctx context.Context,
	ts time.Time,
	id, channelID uuid.UUID,
	body []byte,
	keyVersion int,
) (Message, error) {
	var m Message
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		// 83-3: append-only revisions. Lock the row and read the body this
		// edit displaces BEFORE overwriting it -- the displaced ciphertext is
		// the signed evidence the revision chain (prev_rev_hash) points at,
		// and moving it into message_revisions in the SAME transaction is
		// what makes "edited" and "evidence retained" one atomic fact.
		var displacedTS time.Time
		var displacedBody []byte
		var displacedVer *int
		if err := tx.QueryRow(ctx,
			`SELECT ts, body, key_version FROM messages
			  WHERE id = $2 AND channel_id = $3
			    AND ts >= $1 AND ts < $1 + interval '1 millisecond'
			    AND deleted_at IS NULL
			  FOR UPDATE`,
			ts, id, channelID,
		).Scan(&displacedTS, &displacedBody, &displacedVer); err != nil {
			if !errors.Is(err, pgx.ErrNoRows) {
				return err
			}
			// fall through to the shared not-found/tombstone diagnosis below
			// via the UPDATE's zero-row path -- but without a lock there is
			// nothing to update, so diagnose here directly.
			var exists bool
			if e2 := tx.QueryRow(ctx,
				`SELECT EXISTS(
				   SELECT 1 FROM messages
				    WHERE id = $2 AND channel_id = $3
				      AND ts >= $1 AND ts < $1 + interval '1 millisecond'
				 )`,
				ts, id, channelID,
			).Scan(&exists); e2 != nil {
				return e2
			}
			if exists {
				return ErrAlreadyDeleted
			}
			return ErrMessageNotFound
		}
		var maxRev int
		if err := tx.QueryRow(ctx,
			`SELECT COALESCE(MAX(rev_seq), 0) FROM message_revisions
			  WHERE message_id = $1 AND message_ts = $2`,
			id, displacedTS,
		).Scan(&maxRev); err != nil {
			return err
		}
		// The cap REFUSES the edit rather than dropping old revisions:
		// dropping rev_seq 1 would orphan the chain from its original, which
		// is exactly the evidence the table exists to keep. 64 edits of one
		// message inside the 15-minute window is nobody's typo correction.
		if maxRev >= MaxMessageRevisions {
			return ErrTooManyRevisions
		}
		if _, err := tx.Exec(ctx,
			`INSERT INTO message_revisions
			   (message_id, message_ts, rev_seq, channel_id, body, key_version)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			id, displacedTS, maxRev+1, channelID, displacedBody, displacedVer,
		); err != nil {
			return fmt.Errorf("displace revision: %w", err)
		}
		row := tx.QueryRow(ctx,
			`UPDATE messages
			    SET body = $4,
			        key_version = $5,
			        edited_at = now()
			  WHERE id = $2 AND channel_id = $3
			    AND ts >= $1 AND ts < $1 + interval '1 millisecond'
			    AND deleted_at IS NULL
			 RETURNING channel_id, seq, ts, edited_at`,
			ts, id, channelID, body, keyVersion,
		)
		if err := row.Scan(&m.ChannelID, &m.Seq, &m.TS, &m.EditedAt); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				// Zero rows updated: either no such message in this
				// (ts-window, id, channel_id), or it's a tombstone.
				var exists bool
				if e2 := tx.QueryRow(ctx,
					`SELECT EXISTS(
					   SELECT 1 FROM messages
					    WHERE id = $2 AND channel_id = $3
					      AND ts >= $1 AND ts < $1 + interval '1 millisecond'
					 )`,
					ts, id, channelID,
				).Scan(&exists); e2 != nil {
					return e2
				}
				if exists {
					return ErrAlreadyDeleted
				}
				return ErrMessageNotFound
			}
			return err
		}
		m.ID = id
		m.Body = body
		m.KeyVersion = &keyVersion
		return nil
	})
	if err != nil {
		return Message{}, err
	}
	return m, nil
}

// is the first ack from a non-sender device, the message's delivered_at is
// set to that ack's timestamp.
//
// Idempotent: re-acking is a no-op (PK conflict).
func (s *Store) AckMessage(ctx context.Context, ts time.Time, msgID, deviceID uuid.UUID) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		// Insert the ack. On conflict (already acked), do nothing.
		ct, err := tx.Exec(ctx,
			`INSERT INTO message_acks (message_id, message_ts, device_id, acked_at)
			 VALUES ($1, $2, $3, now())
			 ON CONFLICT (message_id, message_ts, device_id) DO NOTHING`,
			msgID, ts, deviceID,
		)
		if err != nil {
			return fmt.Errorf("insert ack: %w", err)
		}
		if ct.RowsAffected() == 0 {
			// Already acked; nothing else to do.
			return nil
		}

		// First-time ack: maybe set delivered_at. The condition "first ack
		// from a non-sender device" is enforced by:
		//   * delivered_at IS NULL (not yet set), AND
		//   * the acking device is not the sender's device.
		// We do this in a single UPDATE so we don't need a second SELECT.
		_, err = tx.Exec(ctx,
			`UPDATE messages
			   SET delivered_at = now()
			 WHERE ts = $1
			   AND id = $2
			   AND delivered_at IS NULL
			   AND sender_device_id <> $3`,
			ts, msgID, deviceID,
		)
		return err
	})
}

// CountUndeliveredOlderThan returns how many messages exist with delivered_at
// IS NULL and ts < cutoff. Used by the GC sweep in phase 12; exposed here so
// tests can verify the partial index is doing its job.
func (s *Store) CountUndeliveredOlderThan(ctx context.Context, cutoff time.Time) (int64, error) {
	var n int64
	err := s.Pool.QueryRow(ctx,
		`SELECT count(*) FROM messages WHERE delivered_at IS NULL AND ts < $1`,
		cutoff,
	).Scan(&n)
	return n, err
}

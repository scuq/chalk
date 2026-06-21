package store

import (
	"context"
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
}

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
		return row.Scan(&m.TS)
	})
	if err != nil {
		return Message{}, fmt.Errorf("insert message: %w", err)
	}
	return m, nil
}

// GetMessage fetches a message by (ts, id). Both fields are required because
// the messages table is partitioned by ts.
func (s *Store) GetMessage(ctx context.Context, ts time.Time, id uuid.UUID) (Message, error) {
	var m Message
	// Phase 9.6i: LEFT JOIN devices so the WS handler can pass
	// sender_user_id to clients (for username rendering). devices
	// may be missing (purged); coalesce to NULL/uuid.Nil in that
	// case.
	var senderUser *uuid.UUID
	err := s.Pool.QueryRow(ctx,
		`SELECT m.id, m.channel_id, m.thread_id, m.parent_id,
		        m.sender_device_id, d.user_id,
		        m.seq, m.ts, m.delivered_at, m.body, m.key_version
		   FROM messages m
		   LEFT JOIN devices d ON d.id = m.sender_device_id
		  WHERE m.ts = $1 AND m.id = $2`,
		ts, id,
	).Scan(
		&m.ID, &m.ChannelID, &m.ThreadID, &m.ParentID,
		&m.SenderDeviceID, &senderUser,
		&m.Seq, &m.TS, &m.DeliveredAt, &m.Body, &m.KeyVersion,
	)
	if senderUser != nil {
		m.SenderUserID = *senderUser
	}
	return m, translateErr(err)
}

// AckMessage records that a recipient device has acked a message. If this
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

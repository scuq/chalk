package pubsub

import (
	"context"
	"fmt"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// ChannelTopic returns the Postgres NOTIFY topic name for the given
// channel ID. Format: "chalk_chan_<uuid-no-dashes>".
//
// Why this shape:
//   - Prefix "chalk_chan_" lets ops grep for "chalk_*" to see all our
//     topics; distinguishes channel topics from chalk_global.
//   - UUID with dashes removed is 32 hex chars; prefix is 11; total 43.
//     Well under Postgres' 63-char identifier limit.
//   - Lowercase letters + digits + underscore only -- safe to use
//     without quoting in LISTEN/UNLISTEN/NOTIFY (the listener still
//     quotes defensively).
//
// The function is deterministic, so any chalkd publishing to channel C
// and any chalkd subscribed for C will agree on the topic without
// coordination.
func ChannelTopic(channelID uuid.UUID) string {
	return "chalk_chan_" + strings.ReplaceAll(channelID.String(), "-", "")
}

// PublishMessageWithTx emits a NOTIFY on the per-channel topic for ev's
// ChannelID, in the same transaction as the message INSERT.
//
// This replaces (for Kind="message" events) the path through
// PublishWithTx that targeted chalk_global. The wire format of the
// Event payload is identical -- only the NOTIFY channel name differs --
// so listeners that consume both topics use the same dispatch logic.
//
// Phase 06 friend/presence events keep using PublishWithTx (chalk_global).
// They aren't per-channel scoped, and routing them through a single
// topic keeps the simple model.
//
// As with PublishWithTx, the row this event refers to MUST be inserted
// by the same tx; NOTIFY is delivered at COMMIT.
func PublishMessageWithTx(ctx context.Context, tx pgx.Tx, ev Event) error {
	if ev.ChannelID == uuid.Nil {
		return fmt.Errorf("publish message: empty ChannelID")
	}
	if ev.Kind == "" {
		ev.Kind = "message"
	}
	payload, err := ev.Encode()
	if err != nil {
		return err
	}
	topic := ChannelTopic(ev.ChannelID)
	_, err = tx.Exec(ctx, `SELECT pg_notify($1, $2)`, topic, string(payload))
	if err != nil {
		return fmt.Errorf("pg_notify (%s): %w", topic, err)
	}
	return nil
}

// PublishEphemeral emits a NOTIFY on ev's per-channel topic WITHOUT a
// transaction (phase 43-2, typing indicators).
//
// This is only correct for events that reference no row. Anything durable must
// use PublishMessageWithTx so the NOTIFY is delivered at the same COMMIT that
// inserts the row the receiver will go and fetch -- publish a pointer to a row
// that hasn't committed yet and receivers race the writer. A typing ping
// carries its whole meaning in the event and touches no table, so a
// transaction here would be a BEGIN/COMMIT round trip protecting nothing.
//
// The bare pg_notify runs in its own implicit transaction and is delivered
// immediately.
func PublishEphemeral(ctx context.Context, pool *pgxpool.Pool, ev Event) error {
	if ev.ChannelID == uuid.Nil {
		return fmt.Errorf("publish ephemeral: empty ChannelID")
	}
	payload, err := ev.Encode()
	if err != nil {
		return err
	}
	topic := ChannelTopic(ev.ChannelID)
	if _, err := pool.Exec(ctx, `SELECT pg_notify($1, $2)`, topic, string(payload)); err != nil {
		return fmt.Errorf("pg_notify (%s): %w", topic, err)
	}
	return nil
}

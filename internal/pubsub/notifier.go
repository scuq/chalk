// Package pubsub bridges between chalkd instances using Postgres
// LISTEN/NOTIFY. Sending a message inserts it into the database and emits
// a NOTIFY in the same transaction; every chalkd instance has a Listener
// goroutine subscribed to the channel and routes incoming notifications
// to local handlers for fan-out to connected WebSocket clients.
//
// Phase 06 extended the Event envelope for presence and friend
// operations. Phase 08 added Kind="channel" (channel_event push) and
// the ChannelEventPayload field to carry the proto.ChannelSummary.
//
// Event Kind discriminator:
//   * "message"   -- message inserted into a channel; carries MessageID, TS,
//                    ChannelID. Published per-channel via PublishMessageWithTx;
//                    receivers fetch the row.
//   * "presence"  -- aggregated state change; carries UserID. Published on
//                    chalk_global.
//   * "friend"    -- friend op; carries UserID (recipient), FromUserID, and
//                    FriendKind (request_received/accepted/declined/removed).
//                    Published on chalk_global.
//   * "channel"   -- channel membership change (phase 08); carries UserID
//                    (recipient), ChannelID, FriendKind (overloaded as
//                    channel-event-kind: added/removed), and
//                    ChannelEventPayload (JSON-encoded proto.ChannelSummary).
//                    Published on chalk_global so non-members receive it.
package pubsub

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Channel is the Postgres NOTIFY channel name for non-channel-scoped
// events (presence, friend, channel-membership pushes). Per-channel
// message events use ChannelTopic(channelID) instead.
const Channel = "chalk_global"

// Event is the shape of every NOTIFY payload. Kept tiny on purpose to
// stay well under PG's 8000-byte NOTIFY payload limit. The actual
// content (message rows, channel rows) lives in the database; this is
// mostly a routing pointer, with one exception: Kind="channel" events
// carry the full ChannelSummary so receivers don't have to query to
// render the sidebar entry.
type Event struct {
	// Kind discriminates: "message", "presence", "friend", "channel".
	Kind string `json:"k"`

	// Message fields (Kind="message"). MessageID and TS together
	// identify a row in the partitioned messages table.
	MessageID      uuid.UUID `json:"m,omitempty"`
	TS             time.Time `json:"t,omitempty"`
	ChannelID      uuid.UUID `json:"c,omitempty"`
	SenderDeviceID uuid.UUID `json:"s,omitempty"`

	// SenderConnID is the per-conn UUID of the sender's WebSocket
	// connection (Conn.ID). Phase 09a step 3: receivers suppress the
	// echo by connID rather than deviceID so multiple tabs of the
	// same device coexist (each tab has a unique connID).
	//
	// Carried as a string because pubsub doesn't import internal/server
	// and connID is generated server-side via uuid.New().String().
	// Empty string when the sender isn't a connection (e.g. presence
	// or friend events that didn't originate from a WebSocket send).
	SenderConnID string `json:"sc,omitempty"`

	// Presence, friend, and channel fields.
	//   UserID:
	//     For Kind="presence", the user whose aggregated state changed.
	//     For Kind="friend",   the recipient (whose local devices
	//                          should be notified).
	//     For Kind="channel",  the recipient (a member of the channel).
	//   FriendKind:
	//     For Kind="friend",   one of "request_received", "accepted",
	//                          "declined", "removed".
	//     For Kind="channel",  one of "added", "removed".
	//   FromUserID:
	//     For Kind="friend",   the other party.
	//                          Unused for "presence" and "channel".
	UserID     uuid.UUID `json:"u,omitempty"`
	FriendKind string    `json:"fk,omitempty"`
	FromUserID uuid.UUID `json:"f,omitempty"`

	// ChannelEventPayload is the JSON-encoded proto.ChannelSummary
	// for Kind="channel" events. Pubsub doesn't import proto (cycle),
	// so we carry it as opaque bytes; the receiver in server.go
	// decodes into proto.ChannelEventPayload.
	ChannelEventPayload json.RawMessage `json:"cp,omitempty"`

	// InstanceID tags which chalkd published this. Informational.
	InstanceID string `json:"i,omitempty"`
}

// Encode serializes the event for NOTIFY. Returns an error if the
// encoded payload exceeds Postgres' NOTIFY limit (we check at 7800
// bytes with safety margin; Postgres rejects at 8000).
func (e Event) Encode() ([]byte, error) {
	b, err := json.Marshal(e)
	if err != nil {
		return nil, fmt.Errorf("encode event: %w", err)
	}
	if len(b) > 7800 {
		return nil, fmt.Errorf("event payload too large: %d bytes", len(b))
	}
	return b, nil
}

// PublishWithTx emits a NOTIFY on chalk_global inside an existing
// transaction. Use this for presence, friend, and channel-event
// notifications. Per-channel message events use PublishMessageWithTx
// (see channel_topics.go).
//
// NOTIFY is delivered at COMMIT; the row(s) referenced in the event
// MUST be inserted/updated by the same transaction.
func PublishWithTx(ctx context.Context, tx pgx.Tx, ev Event) error {
	payload, err := ev.Encode()
	if err != nil {
		return err
	}
	_, err = tx.Exec(ctx, `SELECT pg_notify($1, $2)`, Channel, string(payload))
	if err != nil {
		return fmt.Errorf("pg_notify: %w", err)
	}
	return nil
}

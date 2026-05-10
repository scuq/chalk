// Package pubsub bridges between chalkd instances using Postgres
// LISTEN/NOTIFY. Sending a message inserts it into the database and emits
// a NOTIFY in the same transaction; every chalkd instance has a Listener
// goroutine subscribed to the channel and routes incoming notifications
// to local handlers for fan-out to connected WebSocket clients.
//
// Phase 06 extends the Event envelope with fields for presence and
// friend operations:
//   * Kind="message"   -- as phase 05; carries MessageID + TS for fetch
//   * Kind="presence"  -- carries UserID whose aggregated state changed
//   * Kind="friend"    -- carries UserID (recipient of the event) and
//                         FromUserID (the other party); the listener
//                         pushes a friend_event frame to the recipient's
//                         locally-connected devices
package pubsub

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Channel is the Postgres NOTIFY channel name. We use a single global
// channel; the Kind field discriminates payload shape.
const Channel = "chalk_global"

// Event is the shape of every NOTIFY payload. Kept tiny on purpose to
// stay well under PG's 8000-byte NOTIFY payload limit. The actual
// content (message rows, aggregated presence) lives in the database;
// this is a routing pointer.
type Event struct {
	// Kind discriminates: "message", "presence", "friend".
	Kind string `json:"k"`

	// Message fields (Kind="message"). MessageID and TS together
	// identify a row in the partitioned messages table.
	MessageID      uuid.UUID `json:"m,omitempty"`
	TS             time.Time `json:"t,omitempty"`
	ChannelID      uuid.UUID `json:"c,omitempty"`
	SenderDeviceID uuid.UUID `json:"s,omitempty"`

	// Presence and friend fields.
	//   UserID:
	//     For Kind="presence", the user whose aggregated state changed.
	//     For Kind="friend",   the recipient of the friend event (the
	//                          party whose local devices should be
	//                          notified).
	//   FriendKind:
	//     For Kind="friend", one of "request_received", "accepted",
	//                       "declined", "removed". Mirrors
	//                       proto.FriendEventPayload.Kind.
	//   FromUserID:
	//     For Kind="friend", the other party (the requester, accepter,
	//                       etc.). For presence, unused.
	UserID     uuid.UUID `json:"u,omitempty"`
	FriendKind string    `json:"fk,omitempty"`
	FromUserID uuid.UUID `json:"f,omitempty"`

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

// PublishWithTx emits a NOTIFY inside an existing transaction. NOTIFY
// is delivered at COMMIT time; the row(s) referenced in the event MUST
// be inserted/updated by the same transaction. Every chalkd's listener,
// including the publishing instance's, receives the notification
// post-commit.
//
// We use pg_notify() (the function form) rather than NOTIFY (the
// statement form) because pg_notify accepts both arguments as values,
// letting us bind the payload string with placeholder syntax. NOTIFY's
// channel name is a SQL identifier and cannot be parameterized.
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

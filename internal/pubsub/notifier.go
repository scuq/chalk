// Package pubsub bridges between chalkd instances using Postgres
// LISTEN/NOTIFY. Sending a message inserts it into the database and emits
// a NOTIFY in the same transaction; every chalkd instance has a Listener
// goroutine subscribed to the channel and routes incoming notifications to
// its local Hub for fan-out to its locally-connected WebSocket clients.
//
// This gives us multi-instance scale-out without an additional message
// broker. Postgres is the source of truth and the message bus.
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
// channel for v1; phase-specific notifications can be routed via the type
// field in the payload.
const Channel = "chalk_global"

// Event is the shape of every NOTIFY payload. Kept tiny on purpose so we
// stay well under PG's 8000-byte NOTIFY payload limit -- the actual message
// content lives in the messages table; this is just a routing pointer.
type Event struct {
	// Kind discriminates: "message" today; phase 06 will add "presence",
	// phase 11 "friend_update", etc.
	Kind string `json:"k"`

	// MessageID and TS together identify a row in the partitioned messages
	// table. Receivers fetch the row to get full content.
	MessageID uuid.UUID `json:"m,omitempty"`
	TS        time.Time `json:"t,omitempty"`

	// ChannelID lets receivers filter early before fetching.
	ChannelID uuid.UUID `json:"c,omitempty"`

	// SenderDeviceID lets the local hub avoid echoing to the sender.
	SenderDeviceID uuid.UUID `json:"s,omitempty"`

	// InstanceID tags which chalkd published this. Currently informational;
	// future extensions (e.g. avoiding double-fan-out in cluster topologies)
	// may rely on it.
	InstanceID string `json:"i,omitempty"`
}

// Encode serializes the event for NOTIFY. Returns an error if the encoded
// payload exceeds Postgres' NOTIFY limit (8000 bytes; Postgres rejects
// payloads at that size, so we check earlier with a small safety margin).
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

// PublishWithTx emits a NOTIFY inside an existing transaction. NOTIFY is
// delivered at COMMIT time, so the row referenced in the event MUST be
// inserted by the same transaction. Any chalkd's listener (including the
// publishing instance's own) receives the notification post-commit.
//
// We use Exec with parameter binding to avoid manual quoting of the JSON
// payload. NOTIFY's first argument is the channel name (an identifier), so
// it can't be parameterized; we use pg_notify() instead, which takes both
// args as values.
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

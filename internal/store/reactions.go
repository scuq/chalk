package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Reaction is one row of message_reactions: one member's whole encrypted set
// of emoji for one message. Body is opaque ciphertext (a sealed JSON array);
// the server never learns which emoji it holds.
type Reaction struct {
	MessageID  uuid.UUID
	MessageTS  time.Time
	UserID     uuid.UUID
	Body       []byte
	KeyVersion *int
	UpdatedAt  time.Time
}

// SetReactions replaces userID's reaction set for one message.
//
// An empty body means "no reactions left" and DELETEs the row rather than
// storing a sealed empty array: absence is the natural representation of
// nothing, it keeps the table small, and it means a reader never has to
// decrypt a row to discover it is empty.
//
// The (ts, id) pair is required because message_reactions carries the
// message's ts to satisfy the composite FK into the partitioned messages
// table. Unlike EditMessage this takes the FULL-precision ts: callers get it
// from GetMessage rather than off the wire, so there is no millis-rounding to
// undo. Passing a wire-rounded ts here would violate the FK.
//
// Returns the stored row. For the delete case Body is nil and UpdatedAt is the
// deletion time, so the caller can still build a push telling everyone that
// this user now reacts with nothing.
func (s *Store) SetReactions(
	ctx context.Context,
	messageTS time.Time,
	messageID, channelID, userID uuid.UUID,
	body []byte,
	keyVersion int,
) (Reaction, error) {
	r := Reaction{
		MessageID: messageID,
		MessageTS: messageTS,
		UserID:    userID,
	}
	if len(body) == 0 {
		_, err := s.Pool.Exec(ctx,
			`DELETE FROM message_reactions
			  WHERE message_id = $1 AND message_ts = $2 AND user_id = $3`,
			messageID, messageTS, userID,
		)
		if err != nil {
			return Reaction{}, fmt.Errorf("clear reactions: %w", err)
		}
		r.UpdatedAt = time.Now()
		return r, nil
	}

	err := s.Pool.QueryRow(ctx,
		`INSERT INTO message_reactions
		   (message_id, message_ts, channel_id, user_id, body, key_version, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, now())
		 ON CONFLICT (message_id, message_ts, user_id) DO UPDATE
		   SET body = EXCLUDED.body,
		       key_version = EXCLUDED.key_version,
		       updated_at = now()
		 RETURNING body, key_version, updated_at`,
		messageID, messageTS, channelID, userID, body, keyVersion,
	).Scan(&r.Body, &r.KeyVersion, &r.UpdatedAt)
	if err != nil {
		return Reaction{}, fmt.Errorf("set reactions: %w", err)
	}
	return r, nil
}

// ListReactionsForMessages returns every reaction row for the given messages
// in one channel. Used to backfill the client after a history fetch, which is
// why it takes a batch: one round trip per channel-open rather than per
// message.
//
// Returns an empty slice when messageIDs is empty rather than issuing a query
// with an empty ANY(), which would scan pointlessly.
func (s *Store) ListReactionsForMessages(
	ctx context.Context,
	channelID uuid.UUID,
	messageIDs []uuid.UUID,
) ([]Reaction, error) {
	if len(messageIDs) == 0 {
		return []Reaction{}, nil
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT message_id, message_ts, user_id, body, key_version, updated_at
		   FROM message_reactions
		  WHERE channel_id = $1 AND message_id = ANY($2)`,
		channelID, messageIDs,
	)
	if err != nil {
		return nil, fmt.Errorf("list reactions: %w", err)
	}
	defer rows.Close()

	out := make([]Reaction, 0, len(messageIDs))
	for rows.Next() {
		var r Reaction
		if err := rows.Scan(
			&r.MessageID, &r.MessageTS, &r.UserID,
			&r.Body, &r.KeyVersion, &r.UpdatedAt,
		); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// GetReaction reads one member's reaction set for one message. found is false
// when the row is absent, which is the normal representation of "this member
// reacts with nothing" -- the pubsub listener uses that to build a push with
// an empty body, telling other clients to drop this member from the tally.
//
// Takes the FULL-precision message ts (it comes from the pubsub event, which
// carries what the handler read out of the row).
func (s *Store) GetReaction(
	ctx context.Context,
	messageTS time.Time,
	messageID, userID uuid.UUID,
) (Reaction, bool, error) {
	r := Reaction{MessageID: messageID, MessageTS: messageTS, UserID: userID}
	err := s.Pool.QueryRow(ctx,
		`SELECT body, key_version, updated_at
		   FROM message_reactions
		  WHERE message_id = $1 AND message_ts = $2 AND user_id = $3`,
		messageID, messageTS, userID,
	).Scan(&r.Body, &r.KeyVersion, &r.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return r, false, nil
	}
	if err != nil {
		return Reaction{}, false, fmt.Errorf("get reaction: %w", err)
	}
	return r, true, nil
}

// ScrubReactionsForMessage removes every reaction on a message. Called from
// the delete path: deleting a message scrubs its body, and leaving the
// reactions behind would keep "eleven people reacted to this" (and to what,
// for anyone still holding the key) attached to content that is supposed to be
// gone from the server.
//
// Takes a transaction because it runs inside the delete's transaction -- the
// scrub and the tombstone commit together or not at all.
func ScrubReactionsForMessageTx(
	ctx context.Context,
	tx pgx.Tx,
	messageTS time.Time,
	messageID uuid.UUID,
) error {
	_, err := tx.Exec(ctx,
		`DELETE FROM message_reactions WHERE message_id = $1 AND message_ts = $2`,
		messageID, messageTS,
	)
	return err
}

// ErrMessageDeleted is returned by the reaction path when the target message
// is a tombstone. Reacting to something that has been retracted is not a
// meaningful action, and the row's reactions are scrubbed on delete anyway.
var ErrMessageDeleted = errors.New("message deleted")

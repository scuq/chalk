package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// 83-3: append-only message revisions. Each edit moves the displaced
// ciphertext into message_revisions inside the edit's own transaction
// (store.EditMessage); this file is the read side plus the tombstone purge.
// The server never reads inside a revision -- like a message body it is
// opaque ciphertext, and the signed chain that links revisions together
// (each edit envelope's prev_rev_hash) is client-side crypto.

// MaxMessageRevisions caps how many displaced bodies one message may
// accumulate. The 65th edit is refused (ErrTooManyRevisions) rather than
// dropping the oldest revision, because rev_seq 1 is the original body --
// the anchor the whole chain verifies back to.
const MaxMessageRevisions = 64

// ErrTooManyRevisions is returned by EditMessage when the revision cap is
// reached. The handler maps it to an explicit edit refusal.
var ErrTooManyRevisions = errors.New("too many revisions")

// MessageRevision is one displaced body. RevSeq counts from 1 in
// displacement order: 1 is the original body, N is what the Nth edit
// displaced. KeyVersion is nil for a displaced pre-encryption plaintext row.
type MessageRevision struct {
	RevSeq      int
	Body        []byte
	KeyVersion  *int
	DisplacedAt time.Time
}

// ListRevisions returns every displaced body for one message, oldest first.
// The channel_id match is part of authz: the handler has already verified
// membership of channelID, and the row filter makes "guess a message id from
// another channel" return nothing rather than leak.
func (s *Store) ListRevisions(
	ctx context.Context,
	ts time.Time,
	messageID, channelID uuid.UUID,
) ([]MessageRevision, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT rev_seq, body, key_version, displaced_at
		   FROM message_revisions
		  WHERE message_id = $2 AND channel_id = $3
		    AND message_ts >= $1 AND message_ts < $1 + interval '1 millisecond'
		  ORDER BY rev_seq ASC`,
		ts, messageID, channelID,
	)
	if err != nil {
		return nil, fmt.Errorf("list revisions: %w", err)
	}
	defer rows.Close()

	out := []MessageRevision{}
	for rows.Next() {
		var r MessageRevision
		if err := rows.Scan(&r.RevSeq, &r.Body, &r.KeyVersion, &r.DisplacedAt); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// PurgeRevisionsForMessageTx removes every revision of a message. Runs inside
// the delete's transaction (like ScrubReactionsForMessageTx): the tombstone
// and the purge commit together or not at all.
func PurgeRevisionsForMessageTx(
	ctx context.Context,
	tx pgx.Tx,
	messageTS time.Time,
	messageID uuid.UUID,
) error {
	_, err := tx.Exec(ctx,
		`DELETE FROM message_revisions WHERE message_id = $1 AND message_ts = $2`,
		messageID, messageTS,
	)
	return err
}

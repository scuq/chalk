package store

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// channelActivityBumpSQL advances (or creates) a channel's newest-message
// pointer. The monotonic WHERE mirrors the client's bumpUnread idiom: a
// replayed or out-of-order write can never move the pointer backwards, so
// calling this from concurrent send paths is harmless.
//
// last_sender_id is resolved through devices at write time (0049 header);
// a missing device row yields NULL, same as a purged user.
const channelActivityBumpSQL = `
	INSERT INTO channel_activity (channel_id, last_msg_id, last_msg_ts, last_msg_seq, last_sender_id)
	VALUES ($1, $2, $3, $4, (SELECT user_id FROM devices WHERE id = $5))
	ON CONFLICT (channel_id) DO UPDATE
	   SET last_msg_id    = EXCLUDED.last_msg_id,
	       last_msg_ts    = EXCLUDED.last_msg_ts,
	       last_msg_seq   = EXCLUDED.last_msg_seq,
	       last_sender_id = EXCLUDED.last_sender_id
	 WHERE EXCLUDED.last_msg_seq > channel_activity.last_msg_seq`

// RecordChannelActivityTx records a newly-committed message as its channel's
// latest activity, inside the caller's transaction. Called from the WS send
// handler and from InsertMessage -- every message, top-level or reply -- so
// the two insert paths cannot disagree about what a channel last said.
func RecordChannelActivityTx(
	ctx context.Context, tx pgx.Tx,
	channelID, msgID, senderDeviceID uuid.UUID,
	ts time.Time, seq int64,
) error {
	_, err := tx.Exec(ctx, channelActivityBumpSQL, channelID, msgID, ts, seq, senderDeviceID)
	return err
}

package store

// 80-9: the guest data path. Every method here runs through Guest.withTx, so
// every query executes as chalk_guest with the 0050 policies pinned to the
// guest's (user, channel) -- a bug in a caller cannot read another room, and
// the queries themselves are the SLIM versions of their app counterparts:
// no threads, no attachments, no governance, because those tables are not
// even grantable to this role.
//
// Voice occupancy (join/leave/state/roster/signal relay) is NOT here: those
// handlers take only server-derived parameters, are membership-checked, and
// must share the app path's channel-row locking (which chalk_guest cannot
// take -- locking reads require UPDATE-policy rows). The WS layer reuses the
// app handlers for them; see server/guest_ws.go.

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/scuq/chalk/internal/pubsub"
)

// ErrStaleKeyVersion is returned when a send claims a key version ahead of
// the channel's current one.
var ErrStaleKeyVersion = errors.New("key_version is ahead of the channel's current version")

// EnsureDevice registers the guest's device row (INSERT under RLS: the
// policy's WITH CHECK pins user_id to the guest). A device id already owned
// by someone else is invisible to this role, so the existence probe fails
// and the caller must pick a fresh id -- a guest cannot rebind a real
// user's device, which is the point.
func (g *Guest) EnsureDevice(ctx context.Context, guestUser, guestChannel, deviceID uuid.UUID, deviceType string) error {
	switch deviceType {
	case "phone", "tablet", "desktop":
	default:
		deviceType = "browser-unknown"
	}
	return g.withTx(ctx, guestUser, guestChannel, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx,
			`INSERT INTO devices (id, user_id, device_type)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (id) DO NOTHING`,
			deviceID, guestUser, deviceType,
		); err != nil {
			return fmt.Errorf("ensure guest device: %w", err)
		}
		var owned bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM devices WHERE id = $1 AND user_id = $2)`,
			deviceID, guestUser,
		).Scan(&owned); err != nil {
			return fmt.Errorf("verify guest device: %w", err)
		}
		if !owned {
			return errors.New("device id unavailable")
		}
		return nil
	})
}

// ChannelSummary returns the guest's one channel in the ListChannelsForUser
// shape (members, activity pointer, cursors), plus the member display names
// -- guests see display names, never guest_<hex> handles.
func (g *Guest) ChannelSummary(ctx context.Context, guestUser, guestChannel uuid.UUID) (ChannelWithMembers, map[uuid.UUID]string, error) {
	var out ChannelWithMembers
	names := map[uuid.UUID]string{}
	err := g.withTx(ctx, guestUser, guestChannel, func(tx pgx.Tx) error {
		var c Channel
		var lastSeq, lastReadSeq, lastMsgSeq int64
		var lastMsgID, lastSender *uuid.UUID
		var lastMsgTS, deletedAt *time.Time
		var lastMsgBody []byte
		var lastMsgKeyVersion *int
		err := tx.QueryRow(ctx,
			`SELECT c.id, c.name, c.is_dm, c.created_by, c.created_at, c.current_key_version,
			        c.rotation_pending, c.rotation_due_from, c.governance_mode, c.channel_type, c.group_name, c.expires_at,
			        GREATEST(COALESCE(cs.next_seq, 1) - 1, 0), COALESCE(cr.last_read_seq, 0),
			        ca.last_msg_id, ca.last_msg_ts, COALESCE(ca.last_msg_seq, 0), ca.last_sender_id,
			        m.body, m.key_version, m.deleted_at
			   FROM channels c
			   LEFT JOIN channel_seq cs ON cs.channel_id = c.id
			   LEFT JOIN channel_reads cr ON cr.channel_id = c.id AND cr.user_id = $2
			   LEFT JOIN channel_activity ca ON ca.channel_id = c.id
			   LEFT JOIN messages m ON m.ts = ca.last_msg_ts AND m.id = ca.last_msg_id
			  WHERE c.id = $1`,
			guestChannel, guestUser,
		).Scan(&c.ID, &c.Name, &c.IsDM, &c.CreatedBy, &c.CreatedAt, &c.CurrentKeyVersion,
			&c.RotationPending, &c.RotationDueFrom, &c.GovernanceMode, &c.ChannelType, &c.GroupName, &c.ExpiresAt,
			&lastSeq, &lastReadSeq,
			&lastMsgID, &lastMsgTS, &lastMsgSeq, &lastSender, &lastMsgBody, &lastMsgKeyVersion, &deletedAt)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrChannelNotFound
		}
		if err != nil {
			return fmt.Errorf("guest channel summary: %w", err)
		}
		out = ChannelWithMembers{
			Channel: c, LastSeq: lastSeq, LastReadSeq: lastReadSeq,
			LastMsgID: lastMsgID, LastMsgTS: lastMsgTS, LastMsgSeq: lastMsgSeq,
			LastMsgSender: lastSender, LastMsgBody: lastMsgBody,
			LastMsgKeyVersion: lastMsgKeyVersion, LastMsgDeleted: deletedAt != nil,
		}

		rows, err := tx.Query(ctx,
			`SELECT cm.user_id, COALESCE(u.display_name, '')
			   FROM channel_members cm
			   LEFT JOIN users u ON u.id = cm.user_id
			  WHERE cm.channel_id = $1`,
			guestChannel)
		if err != nil {
			return fmt.Errorf("guest members: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var uid uuid.UUID
			var name string
			if err := rows.Scan(&uid, &name); err != nil {
				return err
			}
			out.MemberIDs = append(out.MemberIDs, uid)
			names[uid] = name
		}
		return rows.Err()
	})
	if err != nil {
		return ChannelWithMembers{}, nil, err
	}
	return out, names, nil
}

// History returns a page of the scratchpad, newest first: the slim version
// of ListMessagesByChannel (no thread decoration, no attachments -- those
// surfaces do not exist for guests).
func (g *Guest) History(ctx context.Context, guestUser, guestChannel uuid.UUID, beforeSeq int64, limit int) ([]Message, error) {
	if limit <= 0 {
		limit = 50
	}
	if limit > 200 {
		limit = 200
	}
	if beforeSeq <= 0 {
		beforeSeq = 1 << 62
	}
	var out []Message
	err := g.withTx(ctx, guestUser, guestChannel, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx,
			`SELECT m.id, m.channel_id, m.sender_device_id, d.user_id,
			        m.ts, m.seq, m.body, m.key_version,
			        m.deleted_at, m.deleted_by, m.edited_at
			   FROM messages m
			   LEFT JOIN devices d ON d.id = m.sender_device_id
			  WHERE m.channel_id = $1 AND m.seq < $2
			  ORDER BY m.seq DESC
			  LIMIT $3`,
			guestChannel, beforeSeq, limit)
		if err != nil {
			return fmt.Errorf("guest history: %w", err)
		}
		defer rows.Close()
		for rows.Next() {
			var m Message
			var senderDev, senderUser, deletedBy *uuid.UUID
			var deletedAt, editedAt *time.Time
			if err := rows.Scan(
				&m.ID, &m.ChannelID, &senderDev, &senderUser,
				&m.TS, &m.Seq, &m.Body, &m.KeyVersion,
				&deletedAt, &deletedBy, &editedAt,
			); err != nil {
				return err
			}
			if senderDev != nil {
				m.SenderDeviceID = *senderDev
			}
			if senderUser != nil {
				m.SenderUserID = *senderUser
			}
			m.DeletedAt = deletedAt
			m.DeletedBy = deletedBy
			m.EditedAt = editedAt
			out = append(out, m)
		}
		return rows.Err()
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// SendScratch appends one scratchpad message: seq bump, insert, own-cursor
// advance, activity pointer, NOTIFY -- the send transaction's core, under
// RLS. The messages INSERT policy additionally pins sender_device_id to the
// guest's own devices, so even a bug here could not forge a sender.
func (g *Guest) SendScratch(
	ctx context.Context,
	guestUser, guestChannel, deviceID uuid.UUID,
	body []byte, keyVersion int,
	clientMsgID, instanceID, connID string,
) (msgID uuid.UUID, seq int64, ts time.Time, err error) {
	err = g.withTx(ctx, guestUser, guestChannel, func(tx pgx.Tx) error {
		var curVer int
		if err := tx.QueryRow(ctx,
			`SELECT current_key_version FROM channels WHERE id = $1`,
			guestChannel,
		).Scan(&curVer); err != nil {
			return fmt.Errorf("key version: %w", err)
		}
		if keyVersion > curVer {
			return ErrStaleKeyVersion
		}
		if err := tx.QueryRow(ctx,
			`UPDATE channel_seq SET next_seq = next_seq + 1
			   WHERE channel_id = $1
			 RETURNING next_seq - 1`,
			guestChannel,
		).Scan(&seq); err != nil {
			return fmt.Errorf("guest seq: %w", err)
		}
		msgID = uuid.New()
		if err := tx.QueryRow(ctx,
			`INSERT INTO messages (id, channel_id, sender_device_id, seq, body, key_version)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 RETURNING ts`,
			msgID, guestChannel, deviceID, seq, body, keyVersion,
		).Scan(&ts); err != nil {
			return fmt.Errorf("guest insert message: %w", err)
		}
		if err := MarkChannelReadTx(ctx, tx, guestChannel, guestUser, seq); err != nil {
			return err
		}
		if err := RecordChannelActivityTx(ctx, tx, guestChannel, msgID, deviceID, ts, seq); err != nil {
			return err
		}
		return pubsub.PublishMessageWithTx(ctx, tx, pubsub.Event{
			Kind:           "message",
			MessageID:      msgID,
			TS:             ts,
			ChannelID:      guestChannel,
			SenderDeviceID: deviceID,
			SenderConnID:   connID,
			ClientMsgID:    clientMsgID,
			InstanceID:     instanceID,
		})
	})
	if err != nil {
		return uuid.Nil, 0, time.Time{}, err
	}
	return msgID, seq, ts, nil
}

// MarkRead advances the guest's read cursor.
func (g *Guest) MarkRead(ctx context.Context, guestUser, guestChannel uuid.UUID, seq int64) error {
	return g.withTx(ctx, guestUser, guestChannel, func(tx pgx.Tx) error {
		return MarkChannelReadTx(ctx, tx, guestChannel, guestUser, seq)
	})
}

// FetchIdentity returns a co-member's active identity, looking in BOTH
// identity_keys (real members) and ephemeral_identity_keys (fellow guests) --
// two guests in one room verify each other's DTLS fingerprints too. The RLS
// policies scope both tables to the guest's co-members.
func (g *Guest) FetchIdentity(ctx context.Context, guestUser, guestChannel, target uuid.UUID) (IdentityKey, error) {
	var k IdentityKey
	err := g.withTx(ctx, guestUser, guestChannel, func(tx pgx.Tx) error {
		err := tx.QueryRow(ctx,
			`SELECT user_id, generation, x25519_pub, ed25519_pub, self_sig
			   FROM identity_keys
			  WHERE user_id = $1 AND retired_at IS NULL`,
			target,
		).Scan(&k.UserID, &k.Generation, &k.X25519Pub, &k.Ed25519Pub, &k.SelfSig)
		if err == nil {
			return nil
		}
		if !errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("guest fetch identity: %w", err)
		}
		err = tx.QueryRow(ctx,
			`SELECT user_id, 1, x25519_pub, ed25519_pub, self_sig
			   FROM ephemeral_identity_keys WHERE user_id = $1`,
			target,
		).Scan(&k.UserID, &k.Generation, &k.X25519Pub, &k.Ed25519Pub, &k.SelfSig)
		if errors.Is(err, pgx.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return fmt.Errorf("guest fetch ephemeral identity: %w", err)
		}
		return nil
	})
	if err != nil {
		return IdentityKey{}, err
	}
	return k, nil
}

// OwnKeyWrap returns the guest's space-key wrap for one version. The RLS
// policy already restricts channel_keys to recipient = the guest; the WHERE
// repeats it for the reader.
func (g *Guest) OwnKeyWrap(ctx context.Context, guestUser, guestChannel uuid.UUID, keyVersion int) (wrapSuite int, blob []byte, err error) {
	if keyVersion <= 0 {
		keyVersion = 1
	}
	err = g.withTx(ctx, guestUser, guestChannel, func(tx pgx.Tx) error {
		qerr := tx.QueryRow(ctx,
			`SELECT wrap_suite, wrap_blob FROM channel_keys
			  WHERE channel_id = $1 AND key_version = $2 AND recipient_id = $3`,
			guestChannel, keyVersion, guestUser,
		).Scan(&wrapSuite, &blob)
		if errors.Is(qerr, pgx.ErrNoRows) {
			return ErrNotFound
		}
		return qerr
	})
	if err != nil {
		return 0, nil, err
	}
	return wrapSuite, blob, nil
}

package server

// Phase 33-1: read cursors. A client marks a channel read up to a seq; the
// server clamps and stores the cursor (store/reads.go) and pushes the new
// value to the same user's other connections so an unread dot cleared on
// one device clears on all of them.
//
// Cross-instance push follows the prefs pattern: a Kind="read" event on
// chalk_global carrying only the routing pointers (user, channel). The
// consumer (reads_event.go) re-reads the cursor rather than trusting a
// value carried through NOTIFY, so out-of-order delivery can't rewind it.
//
// Nothing here touches message bodies -- an unread cursor is a seq
// comparison, so the server stays a blind relay. Mentions are derived
// client-side from decrypted plaintext and never reach this layer.

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
	"github.com/scuq/chalk/internal/store"
)

func (h *WSHandler) handleMarkRead(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.MarkReadPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id not a UUID")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	userID := h.lookupUserForDevice(ctx, deviceID)
	if userID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}
	member, err := h.store.IsMember(ctx, channelID, userID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership check: "+err.Error())
		return
	}
	if !member {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member of this channel")
		return
	}

	effective, err := h.store.MarkChannelRead(ctx, channelID, userID, p.Seq)
	if err != nil {
		if errors.Is(err, store.ErrChannelNotFound) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidChannel, "unknown channel")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "mark read: "+err.Error())
		return
	}

	ack, _ := proto.NewFrame(proto.TypeMarkReadAck, f.Ref, proto.ReadStatePayload{
		ChannelID:   channelID.String(),
		LastReadSeq: effective,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	if err := h.publishReadState(ctx, userID, channelID, conn.ID); err != nil {
		h.logger.Printf("publish read state: %v", err)
	}
}

// publishReadState emits the Kind="read" event that carries the cursor
// change to the user's other connections, on this instance and every
// other one. The originating conn ID rides along so the device that made
// the change doesn't get its own echo -- it already has the ack.
func (h *WSHandler) publishReadState(
	ctx context.Context,
	userID, channelID uuid.UUID,
	originConnID string,
) error {
	if h.store == nil {
		return errors.New("no store")
	}
	return pgxBegin(ctx, h.store, func(tx pgx.Tx) error {
		return pubsub.PublishWithTx(ctx, tx, pubsub.Event{
			Kind:         "read",
			UserID:       userID,
			ChannelID:    channelID,
			SenderConnID: originConnID,
			InstanceID:   h.instanceID,
		})
	})
}

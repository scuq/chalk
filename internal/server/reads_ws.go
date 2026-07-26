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
	"time"

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

// Phase 42-4: the same ceremony one level down, for a thread's cursor. Copies
// handleMarkRead's order of operations deliberately -- membership is still
// per-channel, the store still clamps and refuses to rewind, and the push still
// carries only routing pointers.
func (h *WSHandler) handleMarkThreadRead(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.MarkThreadReadPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id not a UUID")
		return
	}
	threadID, err := uuid.Parse(p.ThreadID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "thread_id not a UUID")
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

	effective, err := h.store.MarkThreadRead(ctx, threadID, userID, p.Seq)
	if err != nil {
		if errors.Is(err, store.ErrThreadNotFound) {
			// A thread with no replies is not a thread, so there is nothing to
			// have read -- the client is describing something that doesn't
			// exist yet, which is a bad parent rather than a server fault.
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidParent, "unknown thread")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "mark thread read: "+err.Error())
		return
	}

	ack, _ := proto.NewFrame(proto.TypeMarkThreadReadAck, f.Ref, proto.ThreadReadStatePayload{
		ChannelID:   channelID.String(),
		ThreadID:    threadID.String(),
		LastReadSeq: effective,
	})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("mark_thread_read_ack write: %v", err)
	}

	if err := h.publishThreadReadState(ctx, userID, channelID, threadID, conn.ID); err != nil {
		h.logger.Printf("publish thread read state: %v", err)
	}
}

// Phase 42-6: the cross-channel thread inbox.
//
// No per-channel IsMember check here, and that is not an omission: both halves
// of the query are scoped by channel_members in SQL, which is stronger than
// filtering after the fact -- a thread in a channel the caller was removed from
// cannot appear in the result set at all.
func (h *WSHandler) handleThreadInbox(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.ThreadInboxPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	userID := h.lookupUserForDevice(ctx, deviceID)
	if userID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "anonymous senders have no thread inbox")
		return
	}

	window := h.cfg.ThreadActiveWindow
	if window <= 0 {
		// A zero window would mean "nothing is ever active", which is never the
		// intent; DefaultWSConfig sets 48h and this is the belt-and-braces for a
		// directly-constructed config (e.g. in a test).
		window = 48 * time.Hour
	}
	cutoff := time.Now().Add(-window)

	var beforeTS time.Time
	if p.BeforeTS > 0 {
		beforeTS = time.UnixMilli(p.BeforeTS)
	}

	page, err := h.store.ListThreadInbox(ctx, userID, cutoff, beforeTS, p.Limit)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "thread inbox: "+err.Error())
		return
	}

	entry := func(r store.ThreadInboxRow) proto.ThreadInboxEntry {
		e := proto.ThreadInboxEntry{
			ChannelID:           r.ChannelID.String(),
			ThreadID:            r.ThreadID.String(),
			HeadSeq:             r.HeadSeq,
			HeadTS:              r.HeadTS.UnixMilli(),
			HeadBody:            string(r.HeadBody),
			HeadKeyVersion:      r.HeadKeyVersion,
			HeadDeleted:         r.HeadDeleted,
			LastReplySeq:        r.LastReplySeq,
			LastReplyTS:         r.LastReplyTS.UnixMilli(),
			LastReplyBody:       string(r.LastReplyBody),
			LastReplyKeyVersion: r.LastReplyKeyVersion,
			LastReplyDeleted:    r.LastReplyDeleted,
			ReplyCount:          r.ReplyCount,
			LastReadSeq:         r.LastReadSeq,
			Involved:            r.Involved,
		}
		if r.HeadSenderID != nil {
			e.HeadSender = r.HeadSenderID.String()
		}
		if r.LastReplySenderID != nil {
			e.LastReplySender = r.LastReplySenderID.String()
		}
		return e
	}
	pack := func(rows []store.ThreadInboxRow) []proto.ThreadInboxEntry {
		out := make([]proto.ThreadInboxEntry, 0, len(rows))
		for _, r := range rows {
			out = append(out, entry(r))
		}
		return out
	}

	ack, _ := proto.NewFrame(proto.TypeThreadInboxAck, f.Ref, proto.ThreadInboxAckPayload{
		Active:              pack(page.Active),
		AgedUnread:          pack(page.AgedUnread),
		UnreadInvolvedTotal: page.UnreadInvolvedTotal,
		ActiveWindowHours:   int(window / time.Hour),
		HasMoreActive:       page.HasMoreActive,
	})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("thread_inbox_ack write: %v", err)
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

// publishThreadReadState is publishReadState for a thread cursor.
func (h *WSHandler) publishThreadReadState(
	ctx context.Context,
	userID, channelID, threadID uuid.UUID,
	originConnID string,
) error {
	if h.store == nil {
		return errors.New("no store")
	}
	return pgxBegin(ctx, h.store, func(tx pgx.Tx) error {
		return pubsub.PublishWithTx(ctx, tx, pubsub.Event{
			Kind:         "thread_read",
			UserID:       userID,
			ChannelID:    channelID,
			ThreadID:     threadID,
			SenderConnID: originConnID,
			InstanceID:   h.instanceID,
		})
	})
}

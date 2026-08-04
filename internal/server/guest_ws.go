package server

// 80-9: the guest WS path (docs/phases/PHASE-80-EPHEMERAL.md §"The guest fence").
//
// A guest connection is dispatched HERE, never into the app switch, and the
// allowlist below is DEFAULT-DENY: a frame type without an entry answers
// guest_forbidden, so every future frame is closed to guests until someone
// deliberately opens it.
//
// Two tiers inside the allowlist:
//
//   - Data frames (listing, history, send, read cursor, identity and key
//     fetches) run on store.Guest -- every query executes as chalk_guest
//     under the 0050 row-level-security policies, so the database, not this
//     file, is what scopes a guest to its one room.
//
//   - Voice occupancy frames reuse the APP handlers unchanged: they take
//     only server-derived parameters (user/device from the authenticated
//     conn, channel checked against membership -- and a guest is a member of
//     exactly one channel), and they must share the app path's channel-row
//     locking, which chalk_guest deliberately cannot take (locking reads
//     require UPDATE-policy rows; the fence fails closed). The one
//     guest-supplied blob on that surface, the E2E signal payload, is opaque
//     ciphertext relayed exactly as it is for members.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/store"
)

// ErrCodeGuestForbidden is the deny answer for every frame outside the
// guest allowlist.
const ErrCodeGuestForbidden = "guest_forbidden"

// guestAllowedFrames is THE allowlist. The fence test enumerates every frame
// constant in internal/proto and asserts this map contains exactly the set
// below -- so a new frame is guest-denied by default, and ADDING one here
// without updating the test is a red build.
var guestAllowedFrames = map[string]bool{
	proto.TypeListChannels:    true,
	proto.TypeFetchHistory:    true,
	proto.TypeSend:            true,
	proto.TypeMarkRead:        true,
	proto.TypeFetchIdentity:   true,
	proto.TypeFetchChannelKey: true,
	proto.TypeVoiceJoin:       true,
	proto.TypeVoiceLeave:      true,
	proto.TypeVoiceRoster:     true,
	proto.TypeVoiceState:      true,
	proto.TypeVoiceSignal:     true,
}

// dispatchGuestFrame routes one frame from a guest connection.
func (h *WSHandler) dispatchGuestFrame(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !guestAllowedFrames[f.Type] {
		h.sendError(ctx, c, f.Ref, ErrCodeGuestForbidden,
			"guests cannot use "+f.Type)
		return
	}
	switch f.Type {
	// Data path: chalk_guest via store.Guest.
	case proto.TypeListChannels:
		h.handleGuestListChannels(ctx, c, conn, f)
	case proto.TypeFetchHistory:
		h.handleGuestFetchHistory(ctx, c, conn, f)
	case proto.TypeSend:
		h.handleGuestSend(ctx, c, conn, f)
	case proto.TypeMarkRead:
		h.handleGuestMarkRead(ctx, c, conn, f)
	case proto.TypeFetchIdentity:
		h.handleGuestFetchIdentity(ctx, c, conn, f)
	case proto.TypeFetchChannelKey:
		h.handleGuestFetchChannelKey(ctx, c, conn, f)

	// Voice occupancy: shared app handlers (see the header for why).
	case proto.TypeVoiceJoin:
		h.handleVoiceJoin(ctx, c, conn, f)
	case proto.TypeVoiceLeave:
		h.handleVoiceLeave(ctx, c, conn, f)
	case proto.TypeVoiceRoster:
		h.handleVoiceRoster(ctx, c, conn, f)
	case proto.TypeVoiceState:
		h.handleVoiceState(ctx, c, conn, f)
	case proto.TypeVoiceSignal:
		h.handleVoiceSignal(ctx, c, conn, f)

	default:
		// Allowlisted but not dispatched: the map and this switch drifted.
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal,
			"guest frame allowlisted but unhandled: "+f.Type)
	}
}

// guestIdentity pulls the guest (user, channel, device) off the conn. The
// hello path populated these from the resolved ephemeral session; a zero
// value here is a server bug, not client input.
func (h *WSHandler) guestIdentity(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	ref string,
) (user, channel, device uuid.UUID, ok bool) {
	if h.guestStore == nil {
		h.sendError(ctx, c, ref, proto.ErrCodeInternal, "guest store not configured")
		return uuid.Nil, uuid.Nil, uuid.Nil, false
	}
	user, err := uuid.Parse(conn.UserID)
	if err != nil || conn.GuestChannelID == uuid.Nil {
		h.sendError(ctx, c, ref, proto.ErrCodeInternal, "guest identity missing on conn")
		return uuid.Nil, uuid.Nil, uuid.Nil, false
	}
	device, err = uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, ref, proto.ErrCodeBadPayload, "device_id invalid")
		return uuid.Nil, uuid.Nil, uuid.Nil, false
	}
	return user, conn.GuestChannelID, device, true
}

func (h *WSHandler) handleGuestListChannels(
	ctx context.Context, c *websocket.Conn, conn *Conn, f proto.Frame,
) {
	user, channel, _, ok := h.guestIdentity(ctx, c, conn, f.Ref)
	if !ok {
		return
	}
	summary, names, err := h.guestStore.ChannelSummary(ctx, user, channel)
	if errors.Is(err, store.ErrChannelNotFound) {
		// The room expired under this connection; the janitor's kick is on
		// its way, but answer truthfully meanwhile.
		ack, _ := proto.NewFrame(proto.TypeListChannelsAck, f.Ref,
			proto.ListChannelsAckPayload{Channels: []proto.ChannelSummary{}})
		_ = writeFrame(ctx, c, ack, h.cfg.WriteTimeout)
		return
	}
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "list: "+err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeListChannelsAck, f.Ref,
		proto.ListChannelsAckPayload{
			Channels: []proto.ChannelSummary{channelSummaryFromStore(summary, names)},
		})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("guest list_channels_ack write: %v", err)
	}
}

func (h *WSHandler) handleGuestFetchHistory(
	ctx context.Context, c *websocket.Conn, conn *Conn, f proto.Frame,
) {
	var p proto.FetchHistoryPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	user, channel, _, ok := h.guestIdentity(ctx, c, conn, f.Ref)
	if !ok {
		return
	}
	// The guest has one channel; a payload naming another is denied without
	// touching the database (the RLS would blank it anyway).
	if p.ChannelID != "" && p.ChannelID != channel.String() {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member")
		return
	}
	msgs, err := h.guestStore.History(ctx, user, channel, p.BeforeSeq, p.Limit)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "fetch: "+err.Error())
		return
	}
	out := make([]proto.MessagePayload, 0, len(msgs))
	for _, m := range msgs {
		mp := proto.MessagePayload{
			ID:         m.ID.String(),
			ChannelID:  m.ChannelID.String(),
			Seq:        m.Seq,
			TS:         m.TS.UnixMilli(),
			Body:       string(m.Body),
			KeyVersion: m.KeyVersion,
			Deleted:    m.DeletedAt != nil,
		}
		if m.SenderDeviceID != uuid.Nil {
			mp.Sender = m.SenderDeviceID.String()
		}
		if m.SenderUserID != uuid.Nil {
			mp.SenderUserID = m.SenderUserID.String()
		}
		deletedBy, deletedAt := tombstoneOf(m)
		mp.DeletedBy = deletedBy
		mp.DeletedAt = deletedAt
		mp.EditedAt = editedAtOf(m)
		out = append(out, mp)
	}
	ack, _ := proto.NewFrame(proto.TypeFetchHistoryAck, f.Ref, proto.FetchHistoryAckPayload{
		ChannelID: channel.String(),
		BeforeSeq: p.BeforeSeq,
		Messages:  out,
	})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("guest fetch_history_ack write: %v", err)
	}
}

func (h *WSHandler) handleGuestSend(
	ctx context.Context, c *websocket.Conn, conn *Conn, f proto.Frame,
) {
	var p proto.SendPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	if p.KeyVersion == nil || *p.KeyVersion < 1 {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeEncryptionRequired,
			"encryption required: message must carry key_version >= 1")
		return
	}
	// The scratchpad is the guest's whole text surface: no threads, no
	// attachments -- refuse rather than silently drop.
	if p.ParentID != "" || len(p.AttachmentIDs) > 0 {
		h.sendError(ctx, c, f.Ref, ErrCodeGuestForbidden,
			"guests cannot use threads or attachments")
		return
	}
	user, channel, device, ok := h.guestIdentity(ctx, c, conn, f.Ref)
	if !ok {
		return
	}
	if p.ChannelID != "" && p.ChannelID != channel.String() {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member")
		return
	}
	msgID, seq, ts, err := h.guestStore.SendScratch(ctx, user, channel, device,
		[]byte(p.Body), *p.KeyVersion, p.ClientMsgID, h.instanceID, conn.ID)
	if errors.Is(err, store.ErrStaleKeyVersion) {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeStaleKeyVersion,
			"key_version is ahead of the channel's current version")
		return
	}
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "send failed")
		h.logger.Printf("guest send: %v", err)
		return
	}
	if p.ClientMsgID != "" {
		ack, _ := proto.NewFrame(proto.TypeSendAck, f.Ref, proto.SendAckPayload{
			ClientMsgID: p.ClientMsgID,
			ID:          msgID.String(),
			ChannelID:   channel.String(),
			Seq:         seq,
			TS:          ts.UnixMilli(),
		})
		if werr := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); werr != nil {
			h.logger.Printf("guest send_ack write: %v", werr)
		}
	}
}

func (h *WSHandler) handleGuestMarkRead(
	ctx context.Context, c *websocket.Conn, conn *Conn, f proto.Frame,
) {
	var p proto.MarkReadPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	user, channel, _, ok := h.guestIdentity(ctx, c, conn, f.Ref)
	if !ok {
		return
	}
	if p.ChannelID != "" && p.ChannelID != channel.String() {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member")
		return
	}
	if err := h.guestStore.MarkRead(ctx, user, channel, p.Seq); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "mark read: "+err.Error())
		return
	}
	// A guest has one device, so no cross-device read push; the cursor
	// upsert never rewinds (GREATEST), making p.Seq an honest echo.
	ack, _ := proto.NewFrame(proto.TypeMarkReadAck, f.Ref, proto.ReadStatePayload{
		ChannelID:   channel.String(),
		LastReadSeq: p.Seq,
	})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("guest mark_read_ack write: %v", err)
	}
}

func (h *WSHandler) handleGuestFetchIdentity(
	ctx context.Context, c *websocket.Conn, conn *Conn, f proto.Frame,
) {
	var p proto.FetchIdentityPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	user, channel, _, ok := h.guestIdentity(ctx, c, conn, f.Ref)
	if !ok {
		return
	}
	targetID, err := uuid.Parse(p.UserID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "user_id not a UUID")
		return
	}
	k, err := h.guestStore.FetchIdentity(ctx, user, channel, targetID)
	if errors.Is(err, store.ErrNotFound) {
		ack, _ := proto.NewFrame(proto.TypeFetchIdentityAck, f.Ref, proto.FetchIdentityAckPayload{
			Found:  false,
			UserID: p.UserID,
		})
		data, _ := json.Marshal(ack)
		_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
		return
	}
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "fetch identity: "+err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeFetchIdentityAck, f.Ref, proto.FetchIdentityAckPayload{
		Found:      true,
		UserID:     p.UserID,
		Generation: k.Generation,
		X25519Pub:  base64.StdEncoding.EncodeToString(k.X25519Pub),
		Ed25519Pub: base64.StdEncoding.EncodeToString(k.Ed25519Pub),
		SelfSig:    base64.StdEncoding.EncodeToString(k.SelfSig),
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

func (h *WSHandler) handleGuestFetchChannelKey(
	ctx context.Context, c *websocket.Conn, conn *Conn, f proto.Frame,
) {
	var p proto.FetchChannelKeyPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	user, channel, _, ok := h.guestIdentity(ctx, c, conn, f.Ref)
	if !ok {
		return
	}
	if p.ChannelID != "" && p.ChannelID != channel.String() {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member")
		return
	}
	keyVersion := p.KeyVersion
	if keyVersion <= 0 {
		keyVersion = 1
	}
	suite, blob, err := h.guestStore.OwnKeyWrap(ctx, user, channel, keyVersion)
	if errors.Is(err, store.ErrNotFound) {
		ack, _ := proto.NewFrame(proto.TypeFetchChannelKeyAck, f.Ref, proto.FetchChannelKeyAckPayload{
			ChannelID:  channel.String(),
			KeyVersion: keyVersion,
			Found:      false,
		})
		_ = writeFrame(ctx, c, ack, h.cfg.WriteTimeout)
		return
	}
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "fetch key: "+err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeFetchChannelKeyAck, f.Ref, proto.FetchChannelKeyAckPayload{
		ChannelID:  channel.String(),
		KeyVersion: keyVersion,
		Found:      true,
		WrapSuite:  suite,
		Blob:       base64.StdEncoding.EncodeToString(blob),
	})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("guest fetch_channel_key_ack write: %v", err)
	}
}

package server

// 112-1: profile pictures -- set_avatar, list_avatars, and the push.
//
// A picture is encrypted under a channel key, so it exists once per channel
// and every frame here is scoped to one. What travels is an attachment id;
// the bytes went up through the ordinary chunked endpoints and the server
// cannot read them.
//
// Authorization is narrower than it looks. Membership is the floor for both
// frames, and set_avatar adds one more check that matters: the attachment
// must have been uploaded BY THE CALLER. Without it, any member could point
// their avatar at another member's blob -- every id in a channel is
// guessable by anyone who has seen a message carrying it -- and wear
// somebody else's face under their own handle.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/store"
)

func (h *WSHandler) handleSetAvatar(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.SetAvatarPayload
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
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}
	if _, rErr := h.store.GetMemberRole(ctx, channelID, callerID); rErr != nil {
		if errors.Is(rErr, store.ErrNotAMember) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member of channel")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership check: "+rErr.Error())
		return
	}

	id := strings.TrimSpace(p.AttachmentID)
	if id == "" {
		if cErr := h.store.ClearChannelAvatar(ctx, channelID, callerID); cErr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "clear avatar: "+cErr.Error())
			return
		}
		h.ackAvatar(ctx, c, f.Ref, channelID, "")
		h.fanOutAvatar(ctx, channelID, callerID, "", 0)
		return
	}

	attachmentID, aErr := uuid.Parse(id)
	if aErr != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "attachment_id not a UUID")
		return
	}
	att, gErr := h.store.GetAttachmentRefForUser(ctx, attachmentID, callerID)
	if gErr != nil {
		if errors.Is(gErr, store.ErrAttachmentNotFound) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidChannel, "avatar attachment not found")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "avatar lookup: "+gErr.Error())
		return
	}
	if att.ChannelID != channelID {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidChannel,
			"avatar attachment belongs to another channel")
		return
	}
	// The blob must be the caller's own upload. See the file header: this is
	// what stops a member wearing another member's picture.
	uploader := h.lookupUserForDevice(ctx, att.UploaderDeviceID)
	if uploader != callerID {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidChannel,
			"avatar attachment was not uploaded by you")
		return
	}

	if sErr := h.store.SetChannelAvatar(ctx, channelID, callerID, attachmentID, att.KeyVersion); sErr != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "set avatar: "+sErr.Error())
		return
	}
	h.ackAvatar(ctx, c, f.Ref, channelID, attachmentID.String())
	h.fanOutAvatar(ctx, channelID, callerID, attachmentID.String(), att.KeyVersion)
}

func (h *WSHandler) ackAvatar(
	ctx context.Context,
	c *websocket.Conn,
	ref string,
	channelID uuid.UUID,
	attachmentID string,
) {
	ack, _ := proto.NewFrame(proto.TypeSetAvatarAck, ref, proto.SetAvatarAckPayload{
		ChannelID:    channelID.String(),
		AttachmentID: attachmentID,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

// fanOutAvatar tells the channel's members, on every instance. The originator
// has its ack, but its OTHER devices need this too -- so unlike typing, the
// event is not suppressed for the sender's user.
func (h *WSHandler) fanOutAvatar(
	ctx context.Context,
	channelID, userID uuid.UUID,
	attachmentID string,
	keyVersion int,
) {
	if err := h.publishAvatarEvent(ctx, channelID, userID, attachmentID, keyVersion); err != nil {
		h.logger.Printf("publish avatar_update %s/%s: %v", channelID, userID, err)
	}
}

func (h *WSHandler) handleListAvatars(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.ListAvatarsPayload
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
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}

	rows, lErr := h.store.ListChannelAvatars(ctx, channelID, callerID)
	if lErr != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "list avatars: "+lErr.Error())
		return
	}
	out := make([]proto.AvatarWire, 0, len(rows))
	for _, r := range rows {
		out = append(out, proto.AvatarWire{
			UserID:       r.UserID.String(),
			AttachmentID: r.AttachmentID.String(),
			KeyVersion:   r.KeyVersion,
		})
	}
	ack, _ := proto.NewFrame(proto.TypeListAvatarsAck, f.Ref, proto.ListAvatarsAckPayload{
		ChannelID: channelID.String(),
		Avatars:   out,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

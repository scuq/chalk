package server

// 106-2 / 106-3: update_channel -- rename a channel, set or clear its
// short name. 111-1: and set or clear its banner.
//
// Authorization is deliberately the narrowest of the membership handlers:
// the OWNER, in dictator mode, on a non-DM channel. add_member lets any
// member invite because an invite only widens the room; a rename rewrites
// what every member's roster says, so it stays with the person who named
// the channel in the first place. Democratic channels answer
// unilateral_forbidden the way add_member does -- a rename proposal type
// is not built (recorded in PHASE-106-CHANNELNAMES.md).
//
// Nothing cryptographic binds the channel name (envelopes sign message
// bodies and their channel ID, never the row's metadata), so a rename has
// no key or signature consequences. The banner is the same class of
// change: the server stores a uuid pointing at ciphertext it cannot read,
// and the image itself is an ordinary attachment encrypted under the
// channel key -- so a banner is exactly as private as a posted image, and
// no more.

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

func (h *WSHandler) handleUpdateChannel(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.UpdateChannelPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id not a UUID")
		return
	}
	if p.Name == nil && p.ShortName == nil && p.BannerAttachmentID == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "nothing to update")
		return
	}
	// Same fence as create_channel, before any database work.
	if p.Name != nil && (strings.TrimSpace(*p.Name) == "" || len(*p.Name) > 80) {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidChannel,
			"name must be 1-80 chars after trim")
		return
	}
	if p.ShortName != nil {
		if _, nErr := store.NormalizeShortName(*p.ShortName); nErr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidChannel, nErr.Error())
			return
		}
	}
	// 111-1: "" clears the banner; anything else must parse as a UUID
	// before any database work. Whether it names a usable attachment is
	// checked below, once we know the caller may write here at all.
	var bannerID *uuid.UUID
	if p.BannerAttachmentID != nil && strings.TrimSpace(*p.BannerAttachmentID) != "" {
		bid, bErr := uuid.Parse(strings.TrimSpace(*p.BannerAttachmentID))
		if bErr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload,
				"banner_attachment_id not a UUID")
			return
		}
		bannerID = &bid
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

	// Membership first, then role: a non-member learns nothing beyond
	// not_a_member, the same answer every other channel frame gives.
	role, rErr := h.store.GetMemberRole(ctx, channelID, callerID)
	if rErr != nil {
		if errors.Is(rErr, store.ErrNotAMember) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member of channel")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership check: "+rErr.Error())
		return
	}
	if role != "owner" {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotChannelCreator,
			"only the channel owner can rename it or set its banner")
		return
	}

	ch, gErr := h.store.GetChannel(ctx, channelID)
	if gErr != nil {
		if errors.Is(gErr, store.ErrChannelNotFound) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeChannelNotFound, "channel not found")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "channel lookup: "+gErr.Error())
		return
	}
	if ch.IsDM {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidChannel,
			"a DM cannot be renamed; it is named after the other member")
		return
	}
	if ch.GovernanceMode == store.GovernanceModeDemocratic {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeUnilateralForbidden,
			"channel is in democratic mode; renaming is not a proposal type yet")
		return
	}

	// 111-1: the banner must be a completed attachment of THIS channel.
	// Anything else -- another channel's blob, an upload that never
	// finalized, an id that was never issued -- is refused rather than
	// written, so a banner that resolves to nothing cannot be created
	// through this frame. What it depicts is unknowable here: kind and
	// mime live inside enc_meta, which only members can decrypt.
	if bannerID != nil {
		att, aErr := h.store.GetAttachmentRefForUser(ctx, *bannerID, callerID)
		if aErr != nil {
			if errors.Is(aErr, store.ErrAttachmentNotFound) {
				h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidChannel,
					"banner attachment not found")
				return
			}
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "banner lookup: "+aErr.Error())
			return
		}
		if att.ChannelID != channelID {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidChannel,
				"banner attachment belongs to another channel")
			return
		}
	}

	updated, uErr := h.store.UpdateChannelNames(ctx, store.UpdateChannelNamesInput{
		ChannelID:          channelID,
		Name:               p.Name,
		ShortName:          p.ShortName,
		SetBanner:          p.BannerAttachmentID != nil,
		BannerAttachmentID: bannerID,
	})
	if uErr != nil {
		switch {
		case errors.Is(uErr, store.ErrChannelNotFound):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeChannelNotFound, "channel not found")
		case errors.Is(uErr, store.ErrShortNameTooLong), errors.Is(uErr, store.ErrChannelNameRequired):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidChannel, uErr.Error())
		default:
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "update channel: "+uErr.Error())
		}
		return
	}

	members, mErr := h.store.ListMembersForChannel(ctx, channelID)
	if mErr != nil {
		h.logger.Printf("update_channel: members lookup: %v", mErr)
		members = nil
	}
	summary := h.channelEventSummary(ctx, updated, members)

	ack, _ := proto.NewFrame(proto.TypeUpdateChannelAck, f.Ref, proto.UpdateChannelAckPayload{
		Channel: summary,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	// Every member's every device, the caller's other tabs included: the
	// ack settles the requesting tab, the push settles everyone else. The
	// requesting tab folds both idempotently (same name twice is a no-op).
	for _, m := range members {
		if err := h.publishChannelEvent(ctx, m, channelID, "updated", summary); err != nil {
			h.logger.Printf("publish channel_event updated to %s: %v", m, err)
		}
	}
}

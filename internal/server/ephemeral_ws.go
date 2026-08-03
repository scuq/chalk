package server

// 80-7: ephemeral guest-invite frames (docs/PHASE-80-EPHEMERAL.md §"The magic
// link"). Mint parks client-derived public material; list and revoke manage
// the lifecycle. All three are OWNER-only -- the room's creator hands out its
// keys -- and all three refuse on a permanent channel, so this surface simply
// does not exist for the rest of the deployment.

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/store"
)

// maxWrapBlobBytes bounds the parked space-key wrap. Suite 1 is 92 bytes; 4
// KiB leaves room for a future PQ suite (ML-KEM ~1 KB) without letting the
// column become a blob store.
const maxWrapBlobBytes = 4096

// requireEphemeralOwner resolves the caller, the channel, and the owner role
// for the invite frames. Returns (channel, callerID, true) on success; on any
// failure it has already sent the error frame.
func (h *WSHandler) requireEphemeralOwner(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	ref string,
	channelIDRaw string,
) (store.Channel, uuid.UUID, bool) {
	if !h.cfg.Ephemeral.Enabled {
		h.sendError(ctx, c, ref, proto.ErrCodeEphemeralDisabled,
			"ephemeral channels are disabled on this server")
		return store.Channel{}, uuid.Nil, false
	}
	if h.store == nil {
		h.sendError(ctx, c, ref, proto.ErrCodeInternal, "no store configured")
		return store.Channel{}, uuid.Nil, false
	}
	channelID, err := uuid.Parse(channelIDRaw)
	if err != nil {
		h.sendError(ctx, c, ref, proto.ErrCodeBadPayload, "channel_id not a uuid")
		return store.Channel{}, uuid.Nil, false
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, ref, proto.ErrCodeBadPayload, "device_id invalid")
		return store.Channel{}, uuid.Nil, false
	}
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, ref, proto.ErrCodeNotAMember, "anonymous senders cannot manage invites")
		return store.Channel{}, uuid.Nil, false
	}

	ch, err := h.store.GetChannel(ctx, channelID)
	if errors.Is(err, store.ErrChannelNotFound) {
		h.sendError(ctx, c, ref, proto.ErrCodeChannelNotFound, "channel not found")
		return store.Channel{}, uuid.Nil, false
	}
	if err != nil {
		h.sendError(ctx, c, ref, proto.ErrCodeInternal, "load channel: "+err.Error())
		return store.Channel{}, uuid.Nil, false
	}
	if ch.ExpiresAt == nil {
		h.sendError(ctx, c, ref, proto.ErrCodeNotEphemeral, "channel is not ephemeral")
		return store.Channel{}, uuid.Nil, false
	}

	role, err := h.store.GetMemberRole(ctx, channelID, callerID)
	if errors.Is(err, store.ErrNotAMember) {
		h.sendError(ctx, c, ref, proto.ErrCodeNotAMember, "not a channel member")
		return store.Channel{}, uuid.Nil, false
	}
	if err != nil {
		h.sendError(ctx, c, ref, proto.ErrCodeInternal, "role lookup: "+err.Error())
		return store.Channel{}, uuid.Nil, false
	}
	if role != "owner" {
		h.sendError(ctx, c, ref, proto.ErrCodeNotChannelCreator,
			"only the channel owner manages guest invites")
		return store.Channel{}, uuid.Nil, false
	}
	return ch, callerID, true
}

// b64Field decodes a base64 (std) payload field and enforces an exact length
// (want > 0) or a 1..max range (want == 0).
func b64Field(name, val string, want, max int) ([]byte, error) {
	b, err := base64.StdEncoding.DecodeString(val)
	if err != nil {
		return nil, fmt.Errorf("%s: not base64", name)
	}
	if want > 0 && len(b) != want {
		return nil, fmt.Errorf("%s: want %d bytes, got %d", name, want, len(b))
	}
	if want == 0 && (len(b) == 0 || len(b) > max) {
		return nil, fmt.Errorf("%s: want 1..%d bytes, got %d", name, max, len(b))
	}
	return b, nil
}

func (h *WSHandler) handleEphemeralInviteMint(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.EphemeralInviteMintPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	ch, callerID, ok := h.requireEphemeralOwner(ctx, c, conn, f.Ref, p.ChannelID)
	if !ok {
		return
	}

	lookup, err := b64Field("lookup", p.Lookup, 16, 0)
	if err == nil && len(strings.TrimSpace(p.GuestUserID)) == 0 {
		err = errors.New("guest_user_id required")
	}
	var guestID uuid.UUID
	if err == nil {
		guestID, err = uuid.Parse(p.GuestUserID)
		if err != nil {
			err = errors.New("guest_user_id not a uuid")
		} else if guestID == uuid.Nil {
			err = errors.New("guest_user_id must not be nil")
		}
	}
	var x25519, ed25519, selfSig, wrapBlob []byte
	if err == nil {
		x25519, err = b64Field("x25519_pub", p.X25519Pub, 32, 0)
	}
	if err == nil {
		ed25519, err = b64Field("ed25519_pub", p.Ed25519Pub, 32, 0)
	}
	if err == nil {
		selfSig, err = b64Field("self_sig", p.SelfSig, 64, 0)
	}
	if err == nil {
		wrapBlob, err = b64Field("wrap_blob", p.WrapBlob, 0, maxWrapBlobBytes)
	}
	if err == nil && p.WrapSuite < 1 {
		err = errors.New("wrap_suite must be >= 1")
	}
	if err == nil && len(p.Label) > 80 {
		err = errors.New("label too long (max 80)")
	}
	if err == nil && p.TTLSecs < 0 {
		err = errors.New("ttl_secs must be >= 0")
	}
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}

	// The wrap must be under the channel's CURRENT key version; a stale wrap
	// would hand the guest a key that opens nothing.
	if p.KeyVersion != ch.CurrentKeyVersion {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeStaleKeyVersion,
			fmt.Sprintf("wrap is for key version %d, channel is at %d", p.KeyVersion, ch.CurrentKeyVersion))
		return
	}

	// Link lifetime: requested (or the max), capped by the operator's invite
	// ceiling AND the channel's own remaining life -- a link must never
	// outlive the room it opens.
	ttl := h.cfg.Ephemeral.InviteMaxTTL
	if p.TTLSecs > 0 {
		if req := time.Duration(p.TTLSecs) * time.Second; req < ttl {
			ttl = req
		}
	}
	expiresAt := time.Now().UTC().Add(ttl)
	if ch.ExpiresAt.Before(expiresAt) {
		expiresAt = *ch.ExpiresAt
	}
	if !expiresAt.After(time.Now().UTC()) {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotEphemeral, "channel has already expired")
		return
	}

	err = h.store.MintEphemeralInvite(ctx, store.EphemeralInvite{
		Lookup:      lookup,
		ChannelID:   ch.ID,
		CreatedBy:   callerID,
		GuestUserID: guestID,
		X25519Pub:   x25519,
		Ed25519Pub:  ed25519,
		SelfSig:     selfSig,
		KeyVersion:  p.KeyVersion,
		WrapSuite:   p.WrapSuite,
		WrapBlob:    wrapBlob,
		Label:       strings.TrimSpace(p.Label),
		ExpiresAt:   expiresAt,
	}, h.cfg.Ephemeral.MaxGuests)
	switch {
	case errors.Is(err, store.ErrGuestLimit):
		h.sendError(ctx, c, f.Ref, proto.ErrCodeGuestLimit, err.Error())
		return
	case errors.Is(err, store.ErrInviteExists):
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInviteExists, "an invite with this lookup or guest id already exists")
		return
	case errors.Is(err, store.ErrChannelNotFound), errors.Is(err, store.ErrNotEphemeral):
		h.sendError(ctx, c, f.Ref, proto.ErrCodeChannelNotFound, err.Error())
		return
	case err != nil:
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "mint invite: "+err.Error())
		return
	}

	ack, _ := proto.NewFrame(proto.TypeEphemeralInviteMintAck, f.Ref,
		proto.EphemeralInviteMintAckPayload{
			ChannelID: ch.ID.String(),
			Lookup:    p.Lookup,
			ExpiresAt: expiresAt.UnixMilli(),
		})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("ephemeral_invite_mint_ack write: %v", err)
	}
}

func (h *WSHandler) handleEphemeralInviteList(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.EphemeralInviteListPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	ch, _, ok := h.requireEphemeralOwner(ctx, c, conn, f.Ref, p.ChannelID)
	if !ok {
		return
	}
	invites, err := h.store.ListEphemeralInvites(ctx, ch.ID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "list invites: "+err.Error())
		return
	}
	infos := make([]proto.EphemeralInviteInfo, 0, len(invites))
	for _, inv := range invites {
		info := proto.EphemeralInviteInfo{
			Lookup:      base64.StdEncoding.EncodeToString(inv.Lookup),
			GuestUserID: inv.GuestUserID.String(),
			Label:       inv.Label,
			CreatedAt:   inv.CreatedAt.UnixMilli(),
			ExpiresAt:   inv.ExpiresAt.UnixMilli(),
		}
		if inv.RedeemedAt != nil {
			info.RedeemedAt = inv.RedeemedAt.UnixMilli()
		}
		if inv.RevokedAt != nil {
			info.RevokedAt = inv.RevokedAt.UnixMilli()
		}
		infos = append(infos, info)
	}
	ack, _ := proto.NewFrame(proto.TypeEphemeralInviteListAck, f.Ref,
		proto.EphemeralInviteListAckPayload{
			ChannelID: ch.ID.String(),
			Invites:   infos,
			MaxGuests: h.cfg.Ephemeral.MaxGuests,
		})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("ephemeral_invite_list_ack write: %v", err)
	}
}

func (h *WSHandler) handleEphemeralInviteRevoke(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.EphemeralInviteRevokePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	ch, _, ok := h.requireEphemeralOwner(ctx, c, conn, f.Ref, p.ChannelID)
	if !ok {
		return
	}
	lookup, err := b64Field("lookup", p.Lookup, 16, 0)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	err = h.store.RevokeEphemeralInvite(ctx, ch.ID, lookup)
	if errors.Is(err, store.ErrNotFound) {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInviteNotFound, "no such (unrevoked) invite")
		return
	}
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "revoke invite: "+err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeEphemeralInviteRevokeAck, f.Ref,
		proto.EphemeralInviteRevokeAckPayload{
			ChannelID: ch.ID.String(),
			Lookup:    p.Lookup,
		})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("ephemeral_invite_revoke_ack write: %v", err)
	}
}

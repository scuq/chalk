package server

// Phase 11c-1 PR 2: WS handlers for managing MLS channel membership.
//
// add_to_channel and remove_from_channel are pure permission gates
// in this PR. They validate the caller's request and (for adds)
// claim a KeyPackage from chalkd's stock. The actual MLS state
// changes happen on the client, with the resulting Commit shipped
// back via mls_commit_bundle. PR 3 will extend the bundle handler
// to mutate channel_members and write into mls_commits based on
// proposed_adds/proposed_removes declared in the bundle.
//
// Auth model recap (design doc 11c §7):
//   - Adds: caller must be a member of the channel; target must be
//     an accepted friend of the caller and not already a member.
//   - Removes: caller can always remove themselves; otherwise only
//     the channel creator can remove others.

import (
	"context"
	"encoding/base64"
	"errors"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/store"
)

// handleAddToChannel: caller wants to add target_user_id to an
// existing MLS channel. Returns a claimed KeyPackage on success
// so the caller can build the Add commit locally.
func (h *WSHandler) handleAddToChannel(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.AddToChannelPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	if h.friends == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "friends store unavailable")
		return
	}
	if conn.UserID == "" {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotHelloed, "not authenticated")
		return
	}

	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id must be a UUID")
		return
	}
	targetID, err := uuid.Parse(p.TargetUserID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "target_user_id must be a UUID")
		return
	}
	callerID, err := uuid.Parse(conn.UserID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "conn.UserID not a UUID")
		return
	}

	// Channel must exist + be MLS.
	ch, err := h.store.GetChannel(ctx, channelID)
	if err != nil {
		if errors.Is(err, store.ErrChannelNotFound) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsNotMember, "channel not found")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "get channel: "+err.Error())
		return
	}
	if !ch.IsMLS {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsChannelNotEncrypted,
			"channel is not MLS-encrypted")
		return
	}

	// Caller must be a current member.
	callerIsMember, err := h.store.IsMember(ctx, channelID, callerID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership: "+err.Error())
		return
	}
	if !callerIsMember {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsNotMember, "not a member of channel")
		return
	}

	// Target must NOT already be a member.
	targetIsMember, err := h.store.IsMember(ctx, channelID, targetID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "target membership: "+err.Error())
		return
	}
	if targetIsMember {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsAlreadyMember,
			"target user is already a member")
		return
	}

	// Caller + target must be accepted friends (mirrors create_channel).
	areFriends, err := h.friends.AreAcceptedFriends(ctx, callerID, targetID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "friend check: "+err.Error())
		return
	}
	if !areFriends {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotFriends,
			"must be friends with "+targetID.String())
		return
	}

	// Claim one KP for the target. Reuses the same primitive that
	// fetch_key_packages uses; passing a single-user slice gives us
	// the consume semantics for free.
	ciphersuite := p.Ciphersuite
	if ciphersuite == 0 {
		ciphersuite = 1 // MLS suite 0x0001 default
	}
	claimed, err := h.store.ClaimKeyPackagesForUsers(
		ctx, []uuid.UUID{targetID}, ciphersuite,
	)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "claim KP: "+err.Error())
		return
	}
	if len(claimed) == 0 {
		// Target had zero unused KPs across all their devices.
		// ClaimKeyPackagesForUsers silently omits users with no
		// stock; we surface that as a specific error so the client
		// can show "<target> hasn't logged in recently" rather than
		// a generic failure.
		h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsPeerNoKeyPackages,
			"target has no unused KeyPackages; ask them to come online")
		return
	}
	kp := claimed[0]

	ack, _ := proto.NewFrame(proto.TypeAddToChannelAck, f.Ref,
		proto.AddToChannelAckPayload{
			ChannelID:    p.ChannelID,
			TargetUserID: p.TargetUserID,
			KeyPackage: proto.FetchedKeyPackage{
				UserID:         kp.UserID.String(),
				DeviceID:       kp.DeviceID.String(),
				ClientID:       kp.ClientIDClaimed,
				Ciphersuite:    kp.Ciphersuite,
				CredentialType: kp.CredentialType,
				KeyPackageData: base64.StdEncoding.EncodeToString(kp.KeyPackageData),
			},
		})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("add_to_channel_ack write: %v", err)
	}
}

// handleRemoveFromChannel: caller wants to remove target_user_id
// from an existing MLS channel. Pure permission check; on success
// the caller is expected to send mls_commit_bundle with
// proposed_removes=[target] and PR 3's bundle handler will mutate
// channel_members + write to mls_commits.
//
// Permission rule (design doc 11c §7.2):
//   - target == caller: always allowed (member leaves)
//   - target != caller: caller must be the channel creator
//
// Future phases (13+) may add role-based moderation; for 11c-1 the
// creator's "remove others" privilege is the only above-member tier.
func (h *WSHandler) handleRemoveFromChannel(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.RemoveFromChannelPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	if conn.UserID == "" {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotHelloed, "not authenticated")
		return
	}

	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id must be a UUID")
		return
	}
	targetID, err := uuid.Parse(p.TargetUserID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "target_user_id must be a UUID")
		return
	}
	callerID, err := uuid.Parse(conn.UserID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "conn.UserID not a UUID")
		return
	}

	// Channel must exist + be MLS.
	ch, err := h.store.GetChannel(ctx, channelID)
	if err != nil {
		if errors.Is(err, store.ErrChannelNotFound) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsNotMember, "channel not found")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "get channel: "+err.Error())
		return
	}
	if !ch.IsMLS {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsChannelNotEncrypted,
			"channel is not MLS-encrypted")
		return
	}

	// Caller must be a current member.
	callerIsMember, err := h.store.IsMember(ctx, channelID, callerID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership: "+err.Error())
		return
	}
	if !callerIsMember {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsNotMember, "not a member of channel")
		return
	}

	// Target must currently be a member.
	targetIsMember, err := h.store.IsMember(ctx, channelID, targetID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "target membership: "+err.Error())
		return
	}
	if !targetIsMember {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsTargetNotMember,
			"target user is not a member of this channel")
		return
	}

	// Permission check.
	if targetID != callerID {
		// Caller is trying to remove someone other than themselves.
		// Must be the channel creator. ch.CreatedBy is *uuid.UUID
		// because system-owned channels have NULL created_by; anyone
		// trying to remove a member from such a channel can't be its
		// creator, so the nil check naturally fails.
		if ch.CreatedBy == nil || *ch.CreatedBy != callerID {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsNotAuthorized,
				"only the channel creator can remove other members")
			return
		}
	}

	ack, _ := proto.NewFrame(proto.TypeRemoveFromChannelAck, f.Ref,
		proto.RemoveFromChannelAckPayload{
			ChannelID:    p.ChannelID,
			TargetUserID: p.TargetUserID,
		})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("remove_from_channel_ack write: %v", err)
	}
}

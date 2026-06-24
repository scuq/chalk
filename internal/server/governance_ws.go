package server

// gov-1b-1: WebSocket handlers for the governance proposal lifecycle.
//
//   gov_set_mode        -- owner flips dictator->democratic (unilateral)
//   gov_propose         -- open a remove_member/add_member proposal
//   gov_vote            -- cast/change a yes/no ballot
//   gov_cancel          -- author/owner cancels an open proposal
//   gov_list_proposals  -- list open (or all) proposals for a channel
//
// Resolution is resolve-on-certainty: after each vote the proposal is tallied
// and, when the outcome is mathematically locked (or it would be at expiry),
// transitions to a terminal STATUS and a proposal_resolved push goes out. This
// slice does NOT execute the action of a passed proposal (no member is removed
// / added yet) -- the resolve->action dispatch, the set_mode ratchet, mode
// enforcement on the unilateral handlers, and the expiry sweeper are gov-1b-2.

import (
	"context"
	"encoding/json"
	"errors"
	"strings"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
	"github.com/scuq/chalk/internal/store"
)

// ---- push helpers ----------------------------------------------------------

// publishGovernanceEvent emits a governance push for one recipient. Mirrors
// publishChannelEvent: it reuses the opaque ChannelEventPayload byte slot to
// carry the governance JSON, with Kind="governance" and FriendKind the
// sub-kind (mode_changed / proposal_*).
func (h *WSHandler) publishGovernanceEvent(
	ctx context.Context,
	recipient, channelID uuid.UUID,
	kind string,
	payload proto.GovernanceEventPayload,
) error {
	if h.store == nil {
		return errors.New("no store")
	}
	return pgxBegin(ctx, h.store, func(tx pgx.Tx) error {
		buf, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		ev := pubsub.Event{
			Kind:                "governance",
			UserID:              recipient,
			ChannelID:           channelID,
			InstanceID:          h.instanceID,
			FriendKind:          kind,
			ChannelEventPayload: buf,
		}
		return pubsub.PublishWithTx(ctx, tx, ev)
	})
}

// pushGovToMembers fans a governance push out to every current channel member.
func (h *WSHandler) pushGovToMembers(
	ctx context.Context,
	channelID uuid.UUID,
	kind string,
	payload proto.GovernanceEventPayload,
) {
	members, err := h.store.ListMembersForChannel(ctx, channelID)
	if err != nil {
		h.logger.Printf("gov push: list members %s: %v", channelID, err)
		return
	}
	for _, m := range members {
		if perr := h.publishGovernanceEvent(ctx, m, channelID, kind, payload); perr != nil {
			h.logger.Printf("publish governance %s to %s: %v", kind, m, perr)
		}
	}
}

// buildProposalView loads a proposal's current tally and renders the wire view.
// viewer != uuid.Nil fills YourVote; pass uuid.Nil for broadcast pushes.
func (h *WSHandler) buildProposalView(
	ctx context.Context,
	proposalID, viewer uuid.UUID,
) (proto.ProposalView, error) {
	p, res, err := h.store.TallyProposal(ctx, proposalID)
	if err != nil {
		return proto.ProposalView{}, err
	}
	target := ""
	if p.TargetID != nil {
		target = p.TargetID.String()
	}
	yourVote := ""
	if viewer != uuid.Nil {
		if v, ok, gErr := h.store.GetUserVote(ctx, proposalID, viewer); gErr == nil && ok {
			yourVote = v
		}
	}
	return proto.ProposalView{
		ID:        p.ID.String(),
		ChannelID: p.ChannelID.String(),
		Type:      p.Type,
		TargetID:  target,
		Payload:   json.RawMessage(p.Payload),
		CreatedBy: p.CreatedBy.String(),
		CreatedAt: p.CreatedAt.UTC().Format(rfc3339),
		ExpiresAt: p.ExpiresAt.UTC().Format(rfc3339),
		Status:    p.Status,
		Eligible:  res.Eligible,
		Yes:       res.Yes,
		No:        res.No,
		Voted:     res.Voted,
		YourVote:  yourVote,
	}, nil
}

const rfc3339 = "2006-01-02T15:04:05Z07:00"

// ---- gov_set_mode ----------------------------------------------------------

// handleGovSetMode flips a channel's governance mode. gov-1b-1 supports only
// the unilateral dictator->democratic transition (the owner ceding power); the
// democratic->dictator direction returns mode_change_forbidden (it requires a
// supermajority set_mode proposal, wired in gov-1b-2).
func (h *WSHandler) handleGovSetMode(ctx context.Context, c *websocket.Conn, conn *Conn, f proto.Frame) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.GovSetModePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id not a UUID")
		return
	}
	mode := strings.ToLower(strings.TrimSpace(p.Mode))
	if mode != store.GovernanceModeDictator && mode != store.GovernanceModeDemocratic {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadMode, "mode must be dictator or democratic")
		return
	}
	caller := h.callerForConn(ctx, c, conn, f)
	if caller == uuid.Nil {
		return
	}

	role, rErr := h.store.GetMemberRole(ctx, channelID, caller)
	if rErr != nil {
		if errors.Is(rErr, store.ErrNotAMember) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member of channel")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "role check: "+rErr.Error())
		return
	}
	if role != "owner" {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeModeChangeForbidden, "only the channel owner may change governance mode")
		return
	}

	gov, gErr := h.store.GetChannelGovernance(ctx, channelID)
	if gErr != nil {
		if errors.Is(gErr, store.ErrChannelNotFound) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeChannelNotFound, "channel not found")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "governance read: "+gErr.Error())
		return
	}

	if gov.Mode != mode {
		if gov.Mode == store.GovernanceModeDemocratic && mode == store.GovernanceModeDictator {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeModeChangeForbidden,
				"democratic->dictator requires a set_mode proposal (arrives in gov-1b-2)")
			return
		}
		// dictator -> democratic: unilateral.
		if err := h.store.SetGovernanceMode(ctx, channelID, mode); err != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "set mode: "+err.Error())
			return
		}
	}

	ack, _ := proto.NewFrame(proto.TypeGovSetModeAck, f.Ref, proto.GovSetModeAckPayload{
		ChannelID: p.ChannelID,
		Mode:      mode,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	if gov.Mode != mode {
		h.pushGovToMembers(ctx, channelID, proto.GovEventModeChanged, proto.GovernanceEventPayload{
			Kind:      proto.GovEventModeChanged,
			ChannelID: p.ChannelID,
			Mode:      mode,
		})
	}
}

// ---- gov_propose -----------------------------------------------------------

// handlePropose opens a proposal. gov-1b-1 supports remove_member and
// add_member; the channel must be in democratic mode.
func (h *WSHandler) handlePropose(ctx context.Context, c *websocket.Conn, conn *Conn, f proto.Frame) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.GovProposePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id not a UUID")
		return
	}
	caller := h.callerForConn(ctx, c, conn, f)
	if caller == uuid.Nil {
		return
	}

	isMember, mErr := h.store.IsMember(ctx, channelID, caller)
	if mErr != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership check: "+mErr.Error())
		return
	}
	if !isMember {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member of channel")
		return
	}

	gov, gErr := h.store.GetChannelGovernance(ctx, channelID)
	if gErr != nil {
		if errors.Is(gErr, store.ErrChannelNotFound) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeChannelNotFound, "channel not found")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "governance read: "+gErr.Error())
		return
	}
	if gov.Mode != store.GovernanceModeDemocratic {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotDemocratic, "channel is in dictator mode; proposals require democratic mode")
		return
	}

	// Per-type target validation.
	var targetPtr *uuid.UUID
	switch p.Type {
	case store.ProposalTypeRemoveMember:
		targetID, perr := uuid.Parse(p.TargetID)
		if perr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeProposalBadTarget, "remove_member requires a target_id")
			return
		}
		role, rerr := h.store.GetMemberRole(ctx, channelID, targetID)
		if rerr != nil {
			if errors.Is(rerr, store.ErrNotAMember) {
				h.sendError(ctx, c, f.Ref, proto.ErrCodeProposalBadTarget, "target is not a member")
				return
			}
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "target role: "+rerr.Error())
			return
		}
		if role == "owner" {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeProposalBadTarget, "the channel owner cannot be removed")
			return
		}
		targetPtr = &targetID
	case store.ProposalTypeAddMember:
		targetID, perr := uuid.Parse(p.TargetID)
		if perr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeProposalBadTarget, "add_member requires a target_id")
			return
		}
		if _, uErr := h.store.GetUserByID(ctx, targetID); uErr != nil {
			if errors.Is(uErr, store.ErrNotFound) {
				h.sendError(ctx, c, f.Ref, proto.ErrCodeProposalBadTarget, "target user not found")
				return
			}
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "user lookup: "+uErr.Error())
			return
		}
		already, aErr := h.store.IsMember(ctx, channelID, targetID)
		if aErr != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership check: "+aErr.Error())
			return
		}
		if already {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeProposalBadTarget, "target is already a member")
			return
		}
		targetPtr = &targetID
	default:
		h.sendError(ctx, c, f.Ref, proto.ErrCodeProposalForbidden,
			"unsupported proposal type in gov-1b-1 (remove_member, add_member only)")
		return
	}

	pr, _, cErr := h.store.CreateProposal(ctx, store.CreateProposalInput{
		ChannelID: channelID,
		Type:      p.Type,
		TargetID:  targetPtr,
		Payload:   []byte(p.Payload),
		CreatedBy: caller,
	})
	if cErr != nil {
		switch {
		case errors.Is(cErr, store.ErrBelowFloor):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeBelowFloor, "not enough eligible voters to open a proposal")
		case errors.Is(cErr, store.ErrProposalExists):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeProposalExists, "an open proposal for this target already exists")
		case errors.Is(cErr, store.ErrReproposeCooldown):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeReproposeCooldown, "this proposal is in its re-propose cooldown")
		case errors.Is(cErr, store.ErrTooManyOpenProposals):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeTooManyProposals, "you have too many open proposals in this channel")
		case errors.Is(cErr, store.ErrChannelNotFound):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeChannelNotFound, "channel not found")
		default:
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "create proposal: "+cErr.Error())
		}
		return
	}

	view, vErr := h.buildProposalView(ctx, pr.ID, caller)
	if vErr != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "view: "+vErr.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeGovProposeAck, f.Ref, proto.GovProposeAckPayload{Proposal: view})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	bview := view
	bview.YourVote = ""
	h.pushGovToMembers(ctx, channelID, proto.GovEventProposalOpened, proto.GovernanceEventPayload{
		Kind:      proto.GovEventProposalOpened,
		ChannelID: p.ChannelID,
		Proposal:  &bview,
	})
}

// ---- gov_vote --------------------------------------------------------------

// handleVote records (or changes) a ballot, then tallies. If the outcome is
// locked, the proposal resolves to a terminal status and a proposal_resolved
// push goes out; otherwise a proposal_updated push carries the new tally.
func (h *WSHandler) handleVote(ctx context.Context, c *websocket.Conn, conn *Conn, f proto.Frame) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.GovVotePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	proposalID, err := uuid.Parse(p.ProposalID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "proposal_id not a UUID")
		return
	}
	caller := h.callerForConn(ctx, c, conn, f)
	if caller == uuid.Nil {
		return
	}

	if vErr := h.store.CastVote(ctx, proposalID, caller, strings.ToLower(strings.TrimSpace(p.Vote))); vErr != nil {
		switch {
		case errors.Is(vErr, store.ErrBadVote):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeBadVote, "vote must be yes or no")
		case errors.Is(vErr, store.ErrNotEligible):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeNotEligible, "you are not eligible to vote on this proposal")
		case errors.Is(vErr, store.ErrProposalClosed):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeProposalClosed, "proposal is no longer open")
		case errors.Is(vErr, store.ErrProposalNotFound):
			h.sendError(ctx, c, f.Ref, proto.ErrCodeProposalNotFound, "proposal not found")
		default:
			h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "cast vote: "+vErr.Error())
		}
		return
	}

	ack, _ := proto.NewFrame(proto.TypeGovVoteAck, f.Ref, proto.GovVoteAckPayload{
		ProposalID: p.ProposalID,
		Vote:       strings.ToLower(strings.TrimSpace(p.Vote)),
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	pr, res, tErr := h.store.TallyProposal(ctx, proposalID)
	if tErr != nil {
		h.logger.Printf("gov: tally %s: %v", proposalID, tErr)
		return
	}

	if res.Decision == store.DecisionOpen {
		view, vErr := h.buildProposalView(ctx, proposalID, uuid.Nil)
		if vErr != nil {
			h.logger.Printf("gov: view %s: %v", proposalID, vErr)
			return
		}
		h.pushGovToMembers(ctx, pr.ChannelID, proto.GovEventProposalUpdated, proto.GovernanceEventPayload{
			Kind:      proto.GovEventProposalUpdated,
			ChannelID: pr.ChannelID.String(),
			Proposal:  &view,
		})
		return
	}

	// Locked pass/fail -> resolve to status. gov-1b-1 does NOT execute the
	// action; that dispatch (RemoveMember / AddMember / ...) is gov-1b-2.
	status := store.ProposalStatusPassed
	if res.Decision == store.DecisionFail {
		status = store.ProposalStatusFailed
	}
	if mErr := h.store.MarkProposalResolved(ctx, proposalID, status); mErr != nil {
		if !errors.Is(mErr, store.ErrProposalClosed) {
			h.logger.Printf("gov: resolve %s: %v", proposalID, mErr)
		}
	}
	h.logger.Printf("gov: proposal %s resolved %s (action execution arrives in gov-1b-2)", proposalID, status)
	view, vErr := h.buildProposalView(ctx, proposalID, uuid.Nil)
	if vErr != nil {
		h.logger.Printf("gov: view %s: %v", proposalID, vErr)
		return
	}
	h.pushGovToMembers(ctx, pr.ChannelID, proto.GovEventProposalResolved, proto.GovernanceEventPayload{
		Kind:      proto.GovEventProposalResolved,
		ChannelID: pr.ChannelID.String(),
		Proposal:  &view,
	})
}

// ---- gov_cancel ------------------------------------------------------------

// handleCancelProposal cancels an open proposal. Authz: the author or the
// channel owner.
func (h *WSHandler) handleCancelProposal(ctx context.Context, c *websocket.Conn, conn *Conn, f proto.Frame) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.GovCancelPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	proposalID, err := uuid.Parse(p.ProposalID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "proposal_id not a UUID")
		return
	}
	caller := h.callerForConn(ctx, c, conn, f)
	if caller == uuid.Nil {
		return
	}

	pr, gErr := h.store.GetProposal(ctx, proposalID)
	if gErr != nil {
		if errors.Is(gErr, store.ErrProposalNotFound) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeProposalNotFound, "proposal not found")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "get proposal: "+gErr.Error())
		return
	}
	if pr.CreatedBy != caller {
		role, rErr := h.store.GetMemberRole(ctx, pr.ChannelID, caller)
		if rErr != nil || role != "owner" {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeCancelForbidden, "only the author or the channel owner may cancel")
			return
		}
	}

	if mErr := h.store.MarkProposalResolved(ctx, proposalID, store.ProposalStatusCancelled); mErr != nil {
		if errors.Is(mErr, store.ErrProposalClosed) {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeProposalClosed, "proposal is no longer open")
			return
		}
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "cancel: "+mErr.Error())
		return
	}

	ack, _ := proto.NewFrame(proto.TypeGovCancelAck, f.Ref, proto.GovCancelAckPayload{ProposalID: p.ProposalID})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	view, vErr := h.buildProposalView(ctx, proposalID, uuid.Nil)
	if vErr != nil {
		return
	}
	h.pushGovToMembers(ctx, pr.ChannelID, proto.GovEventProposalResolved, proto.GovernanceEventPayload{
		Kind:      proto.GovEventProposalResolved,
		ChannelID: pr.ChannelID.String(),
		Proposal:  &view,
	})
}

// ---- gov_list_proposals ----------------------------------------------------

// handleListProposals returns open proposals (or all, with include_resolved)
// for a channel, each with the caller's own vote filled in.
func (h *WSHandler) handleListProposals(ctx context.Context, c *websocket.Conn, conn *Conn, f proto.Frame) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	var p proto.GovListPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	channelID, err := uuid.Parse(p.ChannelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id not a UUID")
		return
	}
	caller := h.callerForConn(ctx, c, conn, f)
	if caller == uuid.Nil {
		return
	}
	isMember, mErr := h.store.IsMember(ctx, channelID, caller)
	if mErr != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership check: "+mErr.Error())
		return
	}
	if !isMember {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a member of channel")
		return
	}

	props, lErr := h.store.ListProposalsForChannel(ctx, channelID, !p.IncludeResolved)
	if lErr != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "list proposals: "+lErr.Error())
		return
	}
	views := make([]proto.ProposalView, 0, len(props))
	for _, pr := range props {
		v, vErr := h.buildProposalView(ctx, pr.ID, caller)
		if vErr != nil {
			h.logger.Printf("gov: view %s: %v", pr.ID, vErr)
			continue
		}
		views = append(views, v)
	}
	ack, _ := proto.NewFrame(proto.TypeGovListAck, f.Ref, proto.GovListAckPayload{
		ChannelID: p.ChannelID,
		Proposals: views,
	})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

// ---- shared ----------------------------------------------------------------

// callerForConn resolves the authenticated user behind a connection, sending
// the appropriate error frame and returning uuid.Nil on failure.
func (h *WSHandler) callerForConn(ctx context.Context, c *websocket.Conn, conn *Conn, f proto.Frame) uuid.UUID {
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return uuid.Nil
	}
	callerID := h.lookupUserForDevice(ctx, deviceID)
	if callerID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return uuid.Nil
	}
	return callerID
}

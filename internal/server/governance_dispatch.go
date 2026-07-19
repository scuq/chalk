package server

// gov-1b-2: resolve -> action dispatch, the set_mode ratchet, and the expiry
// sweeper. When a proposal locks (in handleVote) or expires (in the sweeper),
// resolveAndDispatch claims the resolution and -- on a pass -- executes the
// action via the same store primitives the unilateral handlers use.
//
// Concurrency: a per-instance in-flight set collapses concurrent dispatch of
// the same proposal locally; finishProposal then claims the terminal status
// via MarkProposalResolved's open-gate (atomic across instances). Only the
// claim winner mutates, so an action never runs twice.

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
	"github.com/scuq/chalk/internal/store"
)

// resolveAndDispatch transitions a decided proposal to its terminal status and
// runs the action on a pass. decision must be DecisionPass or DecisionFail (an
// open decision is a no-op).
func (h *WSHandler) resolveAndDispatch(ctx context.Context, p store.Proposal, decision store.TallyDecision) {
	if _, busy := h.resolving.LoadOrStore(p.ID, struct{}{}); busy {
		return
	}
	defer h.resolving.Delete(p.ID)

	switch decision {
	case store.DecisionFail:
		h.finishProposal(ctx, p, store.ProposalStatusFailed)
	case store.DecisionPass:
		// Read-only H3 precheck decides passed vs passed_moot and yields the
		// mutation to run iff we win the claim.
		status, action := h.planExecution(ctx, p)
		if !h.finishProposal(ctx, p, status) {
			return // another instance already resolved (and, if applicable, acted)
		}
		if action != nil {
			action(ctx)
		}
	}
}

// finishProposal claims the terminal status and, on a successful claim, pushes
// proposal_resolved. Returns true iff this caller won the claim.
func (h *WSHandler) finishProposal(ctx context.Context, p store.Proposal, status string) bool {
	if err := h.store.MarkProposalResolved(ctx, p.ID, status); err != nil {
		if !errors.Is(err, store.ErrProposalClosed) {
			h.logger.Printf("gov: resolve %s: %v", p.ID, err)
		}
		return false
	}
	h.logger.Printf("gov: proposal %s (%s) resolved %s", p.ID, p.Type, status)
	if view, vErr := h.buildProposalView(ctx, p.ID, uuid.Nil); vErr == nil {
		h.pushGovToMembers(ctx, p.ChannelID, proto.GovEventProposalResolved, proto.GovernanceEventPayload{
			Kind:      proto.GovEventProposalResolved,
			ChannelID: p.ChannelID.String(),
			Proposal:  &view,
		})
	}
	return true
}

// planExecution performs the read-only H3 re-check for a passing proposal and
// returns (terminal status, action). action is nil when the proposal is moot.
func (h *WSHandler) planExecution(ctx context.Context, p store.Proposal) (string, func(context.Context)) {
	switch p.Type {
	case store.ProposalTypeRemoveMember:
		if p.TargetID == nil {
			return store.ProposalStatusPassedMoot, nil
		}
		target := *p.TargetID
		if ok, err := h.store.IsMember(ctx, p.ChannelID, target); err != nil || !ok {
			return store.ProposalStatusPassedMoot, nil // already gone
		}
		return store.ProposalStatusPassed, func(ctx context.Context) {
			if err := h.store.RemoveMember(ctx, p.ChannelID, target); err != nil {
				h.logger.Printf("gov: remove_member %s exec: %v", p.ID, err)
				return
			}
			// 30-6: cascade the removal into the channel's voice room.
			h.evictVoiceOnMemberRemoval(ctx, p.ChannelID, target)
			h.pushMemberRemoved(ctx, p.ChannelID, target)
		}

	case store.ProposalTypeAddMember:
		if p.TargetID == nil {
			return store.ProposalStatusPassedMoot, nil
		}
		target := *p.TargetID
		if ok, err := h.store.IsMember(ctx, p.ChannelID, target); err == nil && ok {
			return store.ProposalStatusPassedMoot, nil // already a member
		}
		return store.ProposalStatusPassed, func(ctx context.Context) {
			if err := h.store.AddMember(ctx, p.ChannelID, target); err != nil {
				h.logger.Printf("gov: add_member %s exec: %v", p.ID, err)
				return
			}
			h.pushMemberAdded(ctx, p.ChannelID)
		}

	case store.ProposalTypeDeleteMessage:
		if p.TargetID == nil {
			return store.ProposalStatusPassedMoot, nil
		}
		msgID := *p.TargetID
		var dm struct {
			TS int64 `json:"ts"`
		}
		_ = json.Unmarshal(p.Payload, &dm)
		if dm.TS == 0 {
			return store.ProposalStatusPassedMoot, nil
		}
		deletedBy := p.CreatedBy
		return store.ProposalStatusPassed, func(ctx context.Context) {
			del, err := h.store.DeleteMessage(ctx, time.UnixMilli(dm.TS), msgID, p.ChannelID, deletedBy)
			if err != nil {
				if !errors.Is(err, store.ErrAlreadyDeleted) {
					h.logger.Printf("gov: delete_message %s exec: %v", p.ID, err)
				}
				return
			}
			h.pushMessageDeleted(ctx, p.ChannelID, msgID, del.TS)
		}

	case store.ProposalTypeSetMode:
		// Only democratic->dictator is proposable; revert ownership to the
		// original creator (disallowed -- moot -- if the creator is gone).
		ch, err := h.store.GetChannel(ctx, p.ChannelID)
		if err != nil || ch.CreatedBy == nil {
			return store.ProposalStatusPassedMoot, nil
		}
		creator := *ch.CreatedBy
		if ok, mErr := h.store.IsMember(ctx, p.ChannelID, creator); mErr != nil || !ok {
			return store.ProposalStatusPassedMoot, nil // creator gone
		}
		return store.ProposalStatusPassed, func(ctx context.Context) {
			if err := h.store.SetGovernanceMode(ctx, p.ChannelID, store.GovernanceModeDictator); err != nil {
				h.logger.Printf("gov: set_mode %s exec: %v", p.ID, err)
				return
			}
			h.pushGovToMembers(ctx, p.ChannelID, proto.GovEventModeChanged, proto.GovernanceEventPayload{
				Kind:      proto.GovEventModeChanged,
				ChannelID: p.ChannelID.String(),
				Mode:      store.GovernanceModeDictator,
			})
			// Passing a ratchet-to-dictator cancels other open proposals in
			// the channel (the democratic process is being wound down).
			h.cancelOtherOpenProposals(ctx, p.ChannelID, p.ID)
		}

	default:
		return store.ProposalStatusPassedMoot, nil
	}
}

// cancelOtherOpenProposals resolves every still-open proposal in a channel
// except exceptID to 'cancelled', pushing proposal_resolved for each.
func (h *WSHandler) cancelOtherOpenProposals(ctx context.Context, channelID, exceptID uuid.UUID) {
	open, err := h.store.ListProposalsForChannel(ctx, channelID, true)
	if err != nil {
		h.logger.Printf("gov: list-for-cancel %s: %v", channelID, err)
		return
	}
	for _, op := range open {
		if op.ID == exceptID {
			continue
		}
		if mErr := h.store.MarkProposalResolved(ctx, op.ID, store.ProposalStatusCancelled); mErr != nil {
			if !errors.Is(mErr, store.ErrProposalClosed) {
				h.logger.Printf("gov: cancel-other %s: %v", op.ID, mErr)
			}
			continue
		}
		if view, vErr := h.buildProposalView(ctx, op.ID, uuid.Nil); vErr == nil {
			h.pushGovToMembers(ctx, channelID, proto.GovEventProposalResolved, proto.GovernanceEventPayload{
				Kind:      proto.GovEventProposalResolved,
				ChannelID: channelID.String(),
				Proposal:  &view,
			})
		}
	}
}

// ---- action push fan-outs (mirror the unilateral handlers' push blocks) ----

func (h *WSHandler) pushMemberRemoved(ctx context.Context, channelID, targetID uuid.UUID) {
	ch, gerr := h.store.GetChannel(ctx, channelID)
	if gerr != nil {
		return
	}
	remaining, merr := h.store.ListMembersForChannel(ctx, channelID)
	if merr != nil {
		return
	}
	summary := channelSummaryFromStore(store.ChannelWithMembers{Channel: ch, MemberIDs: remaining}, nil)
	if perr := h.publishChannelEvent(ctx, targetID, channelID, "member_removed", summary); perr != nil {
		h.logger.Printf("publish member_removed to %s: %v", targetID, perr)
	}
	for _, m := range remaining {
		if perr := h.publishChannelEvent(ctx, m, channelID, "member_removed", summary); perr != nil {
			h.logger.Printf("publish member_removed to %s: %v", m, perr)
		}
	}
	if ch.CreatedBy != nil {
		if perr := h.publishChannelEvent(ctx, *ch.CreatedBy, channelID, "rotate_needed", summary); perr != nil {
			h.logger.Printf("publish rotate_needed to owner %s: %v", *ch.CreatedBy, perr)
		}
	}
}

func (h *WSHandler) pushMemberAdded(ctx context.Context, channelID uuid.UUID) {
	ch, gerr := h.store.GetChannel(ctx, channelID)
	if gerr != nil {
		return
	}
	members, lErr := h.store.ListMembersForChannel(ctx, channelID)
	if lErr != nil {
		return
	}
	summary := channelSummaryFromStore(store.ChannelWithMembers{Channel: ch, MemberIDs: members}, nil)
	for _, m := range members {
		if perr := h.publishChannelEvent(ctx, m, channelID, "member_added", summary); perr != nil {
			h.logger.Printf("publish member_added to %s: %v", m, perr)
		}
	}
}

func (h *WSHandler) pushMessageDeleted(ctx context.Context, channelID, messageID uuid.UUID, fullTS time.Time) {
	if perr := pgxBegin(ctx, h.store, func(tx pgx.Tx) error {
		ev := pubsub.Event{
			Kind:       "message_deleted",
			MessageID:  messageID,
			TS:         fullTS,
			ChannelID:  channelID,
			InstanceID: h.instanceID,
		}
		return pubsub.PublishMessageWithTx(ctx, tx, ev)
	}); perr != nil {
		h.logger.Printf("publish message_deleted %s: %v", messageID, perr)
	}
}

// ---- expiry sweeper --------------------------------------------------------

// runGovernanceSweeper periodically resolves proposals whose voting window has
// closed without an early lock. TallyProposal stamps Expired, so the evaluator
// returns a definite pass/fail at the deadline.
func (h *WSHandler) runGovernanceSweeper(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = time.Hour
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	h.sweepExpiredProposals(ctx) // once at startup
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			h.sweepExpiredProposals(ctx)
		}
	}
}

func (h *WSHandler) sweepExpiredProposals(ctx context.Context) {
	if h.store == nil {
		return
	}
	expired, err := h.store.ListExpiredOpenProposals(ctx, 100)
	if err != nil {
		h.logger.Printf("gov sweeper: list expired: %v", err)
		return
	}
	for _, p := range expired {
		_, res, tErr := h.store.TallyProposal(ctx, p.ID)
		if tErr != nil {
			h.logger.Printf("gov sweeper: tally %s: %v", p.ID, tErr)
			continue
		}
		// At expiry EvaluateTally yields pass or fail (never open).
		h.resolveAndDispatch(ctx, p, res.Decision)
	}
}

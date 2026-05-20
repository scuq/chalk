package server

// Phase 11b-1: MLS commit_bundle + welcome ack handlers.
// Phase 11c-1 PR 3: extended with proposed_adds / proposed_removes
// validation, mls_commits persistence, and atomic channel_members
// mutation.
//
// Server-side, the bytes inside commit/welcome/group_id are opaque.
// Auth invariants:
//   * The publisher of a commit_bundle must be a channel member.
//   * Membership changes declared in proposed_adds / proposed_removes
//     must match a recent authorization issued by add_to_channel /
//     remove_from_channel (within 60s, single-use).
//   * Welcomes are fan'd to recipients by user_id; the server
//     iterates a user's connected devices via Hub.FanOutToUser.
//
// Offline recipients drop their welcome silently for 11b-1; PR 4 of
// phase 11c-1 will introduce mls_pending_welcomes to buffer them.

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

func (h *WSHandler) handleMlsCommitBundle(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.MlsCommitBundlePayload
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
	userID, err := uuid.Parse(conn.UserID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "conn.UserID not a UUID")
		return
	}
	deviceID, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "conn.DeviceID not a UUID")
		return
	}
	// Membership: must be in the channel to commit changes to its
	// MLS group. (Equivalent to "must be in the room to change the
	// lock.")
	isMember, err := h.store.IsMember(ctx, channelID, userID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership: "+err.Error())
		return
	}
	if !isMember {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsNotMember, "not a member of channel")
		return
	}

	groupID, err := base64.StdEncoding.DecodeString(p.MlsGroupID)
	if err != nil || len(groupID) == 0 {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsBadBundle, "mls_group_id b64 invalid")
		return
	}
	// commit may be empty (group-creation bundle with welcomes only).
	var commitBytes []byte
	if p.Commit != "" {
		commitBytes, err = base64.StdEncoding.DecodeString(p.Commit)
		if err != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsBadBundle, "commit b64 invalid")
			return
		}
	}

	// Phase 11c-1 PR 3: parse and validate proposed membership changes.
	// Each declared add/remove must have a matching authorization
	// previously issued by handleAddToChannel / handleRemoveFromChannel.
	addUserIDs, removeUserIDs, errCode, errMsg := h.validateProposedMembership(p)
	if errCode != "" {
		h.sendError(ctx, c, f.Ref, errCode, errMsg)
		return
	}

	// Upsert the group row. Idempotent on same (channel_id, group_id);
	// errors if a different group_id is already on file for the channel.
	if err := h.store.UpsertMlsGroup(ctx, channelID, groupID, userID, p.Epoch); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsBadBundle, "upsert mls_group: "+err.Error())
		return
	}

	// Phase 11c-1 PR 3: persist the commit bytes (so late-joining
	// devices can replay) AND mutate channel_members in a single
	// transaction. Skipped if there's no commit (group-creation-only
	// bundles with welcomes still go through UpsertMlsGroup above
	// but don't have a separate commit to store).
	if len(commitBytes) > 0 {
		err := h.store.InsertMlsCommitAndApplyMembership(
			ctx, channelID, p.Epoch, commitBytes,
			userID, deviceID,
			addUserIDs, removeUserIDs,
		)
		if err != nil {
			if errors.Is(err, store.ErrMlsCommitEpochExists) {
				// Stale-commit race: another member committed first
				// at this epoch. Client must catch up to the winning
				// commit (via mls_commit_event push -- handled in
				// PR 4 of 11c-1 series) and retry at the new epoch.
				h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsStaleCommit,
					"another commit landed first at this epoch; retry against the new epoch")
				return
			}
			h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsBadBundle,
				"persist commit + membership: "+err.Error())
			return
		}
	}

	// Fan welcomes to recipients. Each recipient's user_id maps to
	// zero or more connected devices via Hub.FanOutToUser, which
	// expects pre-marshaled bytes -- so we marshal the welcome
	// frame per-recipient (cheap, the welcome bytes are already in
	// the frame; just JSON-wrap).
	delivered := 0
	for i, wf := range p.WelcomeFor {
		if wf.UserID == "" || wf.Welcome == "" {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsBadBundle,
				"welcome_for["+itoa(i)+"]: empty user_id or welcome")
			return
		}
		if _, err := base64.StdEncoding.DecodeString(wf.Welcome); err != nil {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsBadBundle,
				"welcome_for["+itoa(i)+"]: welcome b64 invalid")
			return
		}
		pushFrame, ferr := proto.NewFrame(proto.TypeMlsWelcome, "",
			proto.MlsWelcomePayload{
				ChannelID:    p.ChannelID,
				MlsGroupID:   p.MlsGroupID,
				Welcome:      wf.Welcome,
				SenderUserID: conn.UserID,
			})
		if ferr != nil {
			h.logger.Printf("mls_commit_bundle: build welcome frame: %v", ferr)
			continue
		}
		data, mErr := json.Marshal(pushFrame)
		if mErr != nil {
			h.logger.Printf("mls_commit_bundle: marshal welcome frame: %v", mErr)
			continue
		}
		// FanOutToUser writes to every connected device of the user
		// EXCEPT the conn we pass (so the sender doesn't get their
		// own welcome echoed back). conn.ID is the sender's conn;
		// recipients are different users so they won't match anyway.
		h.hub.FanOutToUser(wf.UserID, conn.ID, data)
		// Did anyone receive it? Crude check: if user has zero conns,
		// the welcome is lost for 11b-1.
		if len(h.hub.ConnsForUser(wf.UserID)) > 0 {
			delivered++
		} else {
			h.logger.Printf("mls_commit_bundle: user %s offline, welcome dropped", wf.UserID)
		}
	}

	ack, _ := proto.NewFrame(proto.TypeMlsCommitBundleAck, f.Ref,
		proto.MlsCommitBundleAckPayload{
			ChannelID: p.ChannelID,
			Delivered: delivered,
		})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("mls_commit_bundle_ack write: %v", err)
	}
}

// validateProposedMembership parses and validates the
// ProposedAdds / ProposedRemoves fields of an mls_commit_bundle.
// Each entry must have a matching authorization in the in-memory
// auth cache (issued by add_to_channel / remove_from_channel).
// Returns parsed UUID slices on success, or (nil, nil, errCode,
// errMsg) on failure.
//
// Single-use semantics: authorizations are consumed on success.
// If validation fails partway through a multi-entry list, any
// previously-consumed authorizations from this call are NOT
// re-issued; the caller would need to re-authorize each before
// retrying. (This is a deliberate choice -- complicating the
// rollback path for a rare error case isn't worth it. A failing
// bundle that's racing should just re-authorize cleanly.)
func (h *WSHandler) validateProposedMembership(
	p proto.MlsCommitBundlePayload,
) (addIDs, removeIDs []uuid.UUID, errCode, errMsg string) {
	// No proposed changes -> no validation needed. This is the
	// common case (key-rotation Updates, Welcome-only bundles).
	if len(p.ProposedAdds) == 0 && len(p.ProposedRemoves) == 0 {
		return nil, nil, "", ""
	}

	if h.authStore == nil {
		// Defensive: should never happen if NewWSHandler ran.
		return nil, nil, proto.ErrCodeInternal, "authStore not configured"
	}

	addIDs = make([]uuid.UUID, 0, len(p.ProposedAdds))
	for _, s := range p.ProposedAdds {
		uid, err := uuid.Parse(s)
		if err != nil {
			return nil, nil, proto.ErrCodeBadPayload,
				"proposed_adds: invalid UUID: " + s
		}
		if !h.authStore.Consume(p.ChannelID, s, AuthKindAdd) {
			return nil, nil, proto.ErrCodeMlsCommitUnauthorized,
				"proposed_adds: no authorization for " + s
		}
		addIDs = append(addIDs, uid)
	}

	removeIDs = make([]uuid.UUID, 0, len(p.ProposedRemoves))
	for _, s := range p.ProposedRemoves {
		uid, err := uuid.Parse(s)
		if err != nil {
			return nil, nil, proto.ErrCodeBadPayload,
				"proposed_removes: invalid UUID: " + s
		}
		if !h.authStore.Consume(p.ChannelID, s, AuthKindRemove) {
			return nil, nil, proto.ErrCodeMlsCommitUnauthorized,
				"proposed_removes: no authorization for " + s
		}
		removeIDs = append(removeIDs, uid)
	}

	return addIDs, removeIDs, "", ""
}

func (h *WSHandler) handleMlsWelcomeAck(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	// 11b-1: pure bookkeeping log. Future use: cancel a buffered-
	// welcome retry timer when the recipient confirms processing.
	var p proto.MlsWelcomeAckPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	h.logger.Printf("mls_welcome_ack: user=%s channel=%s ok=%v",
		conn.UserID, p.ChannelID, p.OK)
	// No response needed; clients fire-and-forget.
}

// itoa avoids pulling in strconv for one int formatter.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

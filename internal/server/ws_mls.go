package server

// Phase 11b-1: MLS commit_bundle + welcome ack handlers.
// Phase 11c-1 PR 3: + proposed_adds / proposed_removes validation +
//   atomic mls_commits write + channel_members mutation.
// Phase 11c-1 PR 4: + welcomes buffered to mls_pending_welcomes;
//   handleMlsWelcomeAck deletes; drainPendingMlsWelcomes on hello.
// Phase 11c-1 PR 5: + LIVE BROADCAST of every Commit to existing
//   channel members via mls_commit_event push (closes the
//   "existing members never hear about the commit" gap that was
//   acceptable for 2-party DMs but breaks for 3+ member channels).
//   + handleFetchMlsCommits: client-initiated catchup that streams
//   stored commits in epoch order to a reconnecting client.

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"time"

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

	// PR 3: validate proposed membership changes.
	addUserIDs, removeUserIDs, errCode, errMsg := h.validateProposedMembership(p)
	if errCode != "" {
		h.sendError(ctx, c, f.Ref, errCode, errMsg)
		return
	}

	// Upsert the group row.
	if err := h.store.UpsertMlsGroup(ctx, channelID, groupID, userID, p.Epoch); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsBadBundle, "upsert mls_group: "+err.Error())
		return
	}

	// PR 3: persist commit + atomic channel_members mutation.
	if len(commitBytes) > 0 {
		err := h.store.InsertMlsCommitAndApplyMembership(
			ctx, channelID, p.Epoch, commitBytes,
			userID, deviceID,
			addUserIDs, removeUserIDs,
		)
		if err != nil {
			if errors.Is(err, store.ErrMlsCommitEpochExists) {
				h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsStaleCommit,
					"another commit landed first at this epoch; retry against the new epoch")
				return
			}
			h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsBadBundle,
				"persist commit + membership: "+err.Error())
			return
		}
	}

	// Phase 11c-3 PR 1: for each newly-added user, publish
	// channel_event{kind="added"} so the new member's other-instance
	// connected devices (or this-instance peers) see the channel pop
	// into the sidebar without waiting for a reconnect. Mirrors what
	// handleCreateChannel does on initial channel creation.
	if len(addUserIDs) > 0 {
		h.publishMlsAddChannelEvents(ctx, channelID, addUserIDs)
	}

	// PR 5: live-broadcast the commit to existing channel members.
	// Recipient set = (current channel members) - (sender) - (newly
	// added members from proposed_adds). New members get their
	// initial group state via the Welcome path, not the commit
	// event. Skipped if there's no commit (group-creation bundles).
	if len(commitBytes) > 0 {
		h.fanOutMlsCommitEvent(
			ctx, conn, channelID, p.Epoch, p.Commit, addUserIDs, userID,
		)
	}

	// Fan welcomes to recipients. PR 4: also buffer in
	// mls_pending_welcomes regardless of online status.
	delivered := 0
	for i, wf := range p.WelcomeFor {
		if wf.UserID == "" || wf.Welcome == "" {
			h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsBadBundle,
				"welcome_for["+itoa(i)+"]: empty user_id or welcome")
			return
		}
		welcomeBytes, derr := base64.StdEncoding.DecodeString(wf.Welcome)
		if derr != nil {
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
		h.hub.FanOutToUser(wf.UserID, conn.ID, data)

		// PR 4: buffer regardless of live-delivery state.
		recipientUUID, perr := uuid.Parse(wf.UserID)
		if perr != nil {
			h.logger.Printf("mls_commit_bundle: welcome_for[%d]: target %q not a UUID; not buffering",
				i, wf.UserID)
		} else {
			berr := h.store.InsertPendingWelcome(
				ctx, recipientUUID, channelID, groupID, welcomeBytes, userID,
			)
			if berr != nil {
				h.logger.Printf("mls_commit_bundle: buffer welcome for %s: %v",
					wf.UserID, berr)
			}
		}

		if len(h.hub.ConnsForUser(wf.UserID)) > 0 {
			delivered++
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

// fanOutMlsCommitEvent broadcasts an mls_commit_event push frame to
// every current member of the channel EXCEPT the sender and the
// newly-added members. The newly-added members get their initial
// group state via the Welcome path; they don't need (and CoreCrypto
// can't process) this commit yet.
//
// Errors are logged but non-fatal: a failed fanout doesn't abort
// the commit. Offline members will pick up the commit via
// handleFetchMlsCommits on their next reconnect.
func (h *WSHandler) fanOutMlsCommitEvent(
	ctx context.Context,
	sender *Conn,
	channelID uuid.UUID,
	epoch int64,
	commitB64 string,
	newlyAdded []uuid.UUID,
	senderID uuid.UUID,
) {
	members, err := h.store.ListMembersForChannel(ctx, channelID)
	if err != nil {
		h.logger.Printf("fanOutMlsCommitEvent: ListMembersForChannel: %v", err)
		return
	}

	// Build exclusion set: sender + newly-added members.
	excluded := make(map[uuid.UUID]struct{}, len(newlyAdded)+1)
	excluded[senderID] = struct{}{}
	for _, u := range newlyAdded {
		excluded[u] = struct{}{}
	}

	// Build the push frame once; marshal once; fan out per recipient.
	push, ferr := proto.NewFrame(proto.TypeMlsCommitEvent, "",
		proto.MlsCommitEventPayload{
			ChannelID:         channelID.String(),
			Epoch:             epoch,
			Commit:            commitB64,
			CommittedByUserID: senderID.String(),
			CommittedAt:       time.Now().UTC(),
		})
	if ferr != nil {
		h.logger.Printf("fanOutMlsCommitEvent: build frame: %v", ferr)
		return
	}
	data, mErr := json.Marshal(push)
	if mErr != nil {
		h.logger.Printf("fanOutMlsCommitEvent: marshal frame: %v", mErr)
		return
	}

	count := 0
	for _, memberID := range members {
		if _, skip := excluded[memberID]; skip {
			continue
		}
		// FanOutToUser handles "user not connected" silently. Offline
		// members will catch up via handleFetchMlsCommits later.
		h.hub.FanOutToUser(memberID.String(), sender.ID, data)
		count++
	}
	if count > 0 {
		h.logger.Printf("fanOutMlsCommitEvent: channel=%s epoch=%d recipients=%d",
			channelID, epoch, count)
	}
}

// handleFetchMlsCommits streams every stored commit for a channel
// with epoch > AfterEpoch to the calling client, in epoch order,
// as a sequence of mls_commit_event push frames. Ends with a
// fetch_mls_commits_ack frame carrying the total count.
//
// The client uses this to catch up its local CoreCrypto state when
// it knows its known_epoch lags the server's stored history (e.g.
// after a reconnect, or after receiving an mls_stale_commit error
// from a racing mls_commit_bundle).
func (h *WSHandler) handleFetchMlsCommits(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.FetchMlsCommitsPayload
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
	callerID, err := uuid.Parse(conn.UserID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "conn.UserID not a UUID")
		return
	}

	// Caller must be a current member of the channel (to prevent
	// using catchup as an information-disclosure side channel).
	isMember, err := h.store.IsMember(ctx, channelID, callerID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership: "+err.Error())
		return
	}
	if !isMember {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeMlsNotMember, "not a member of channel")
		return
	}

	commits, err := h.store.ListMlsCommitsSince(ctx, channelID, p.AfterEpoch)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal,
			"list commits: "+err.Error())
		return
	}

	// Stream each commit as an mls_commit_event push frame.
	pushed := 0
	for _, mc := range commits {
		push, ferr := proto.NewFrame(proto.TypeMlsCommitEvent, "",
			proto.MlsCommitEventPayload{
				ChannelID:         mc.ChannelID.String(),
				Epoch:             mc.Epoch,
				Commit:            base64.StdEncoding.EncodeToString(mc.CommitBytes),
				CommittedByUserID: mc.CommittedByUserID.String(),
				CommittedAt:       mc.CommittedAt.UTC(),
			})
		if ferr != nil {
			h.logger.Printf("handleFetchMlsCommits: build frame epoch=%d: %v",
				mc.Epoch, ferr)
			continue
		}
		if err := writeFrame(ctx, c, push, h.cfg.WriteTimeout); err != nil {
			h.logger.Printf("handleFetchMlsCommits: write event epoch=%d: %v",
				mc.Epoch, err)
			// Connection likely broken; abort the stream. The client
			// can retry on next connect.
			return
		}
		pushed++
	}

	// Final ack with the count.
	ack, _ := proto.NewFrame(proto.TypeFetchMlsCommitsAck, f.Ref,
		proto.FetchMlsCommitsAckPayload{
			ChannelID: p.ChannelID,
			Count:     pushed,
		})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("fetch_mls_commits_ack write: %v", err)
	}
}

// validateProposedMembership parses and validates the
// ProposedAdds / ProposedRemoves fields of an mls_commit_bundle.
// (See PR 3 design notes.)
func (h *WSHandler) validateProposedMembership(
	p proto.MlsCommitBundlePayload,
) (addIDs, removeIDs []uuid.UUID, errCode, errMsg string) {
	if len(p.ProposedAdds) == 0 && len(p.ProposedRemoves) == 0 {
		return nil, nil, "", ""
	}

	if h.authStore == nil {
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
	var p proto.MlsWelcomeAckPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	h.logger.Printf("mls_welcome_ack: user=%s channel=%s ok=%v",
		conn.UserID, p.ChannelID, p.OK)

	// PR 4: delete the buffered welcome row on OK=true.
	if p.OK && h.store != nil && conn.UserID != "" && p.ChannelID != "" {
		userUUID, uerr := uuid.Parse(conn.UserID)
		channelUUID, cerr := uuid.Parse(p.ChannelID)
		if uerr != nil || cerr != nil {
			h.logger.Printf("mls_welcome_ack: skipping delete -- bad UUIDs: u=%v c=%v",
				uerr, cerr)
			return
		}
		if err := h.store.DeletePendingWelcome(ctx, userUUID, channelUUID); err != nil {
			h.logger.Printf("mls_welcome_ack: DeletePendingWelcome: %v", err)
		}
	}
}

// drainPendingMlsWelcomes pushes buffered welcomes to a freshly
// connected user. See PR 4.
func (h *WSHandler) drainPendingMlsWelcomes(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
) {
	if h.store == nil || conn.UserID == "" {
		return
	}
	userUUID, err := uuid.Parse(conn.UserID)
	if err != nil {
		return
	}
	pending, err := h.store.DrainPendingWelcomesForUser(ctx, userUUID)
	if err != nil {
		h.logger.Printf("drainPendingMlsWelcomes: %v", err)
		return
	}
	if len(pending) == 0 {
		return
	}
	h.logger.Printf("drainPendingMlsWelcomes: pushing %d welcome(s) to user=%s",
		len(pending), conn.UserID)
	for _, w := range pending {
		push, ferr := proto.NewFrame(proto.TypeMlsWelcome, "",
			proto.MlsWelcomePayload{
				ChannelID:    w.ChannelID.String(),
				MlsGroupID:   base64.StdEncoding.EncodeToString(w.MlsGroupID),
				Welcome:      base64.StdEncoding.EncodeToString(w.WelcomeBytes),
				SenderUserID: w.SenderUserID.String(),
			})
		if ferr != nil {
			h.logger.Printf("drainPendingMlsWelcomes: build frame for channel %s: %v",
				w.ChannelID, ferr)
			continue
		}
		if err := writeFrame(ctx, c, push, h.cfg.WriteTimeout); err != nil {
			h.logger.Printf("drainPendingMlsWelcomes: write for channel %s: %v",
				w.ChannelID, err)
			return
		}
	}
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

// publishMlsAddChannelEvents publishes a channel_event{kind="added"}
// to each newly-added user_id. Builds a fresh ChannelSummary using
// the post-commit membership state (the commit has just applied
// channel_members changes by this point).
//
// Errors are non-fatal and logged: the recipient will still pick up
// the channel on next reconnect via list_channels. We don't surface
// the failure to the original committer because the commit itself
// succeeded -- this is auxiliary UX delivery.
//
// Phase 11c-3 PR 1.
func (h *WSHandler) publishMlsAddChannelEvents(
	ctx context.Context,
	channelID uuid.UUID,
	addUserIDs []uuid.UUID,
) {
	if h.store == nil || len(addUserIDs) == 0 {
		return
	}
	ch, err := h.store.GetChannel(ctx, channelID)
	if err != nil {
		h.logger.Printf("publishMlsAddChannelEvents: GetChannel: %v", err)
		return
	}
	memberIDs, err := h.store.ListMembersForChannel(ctx, channelID)
	if err != nil {
		h.logger.Printf("publishMlsAddChannelEvents: ListMembersForChannel: %v", err)
		return
	}
	handles, hErr := h.store.HandlesByID(ctx, memberIDs)
	if hErr != nil {
		h.logger.Printf("publishMlsAddChannelEvents: HandlesByID: %v", hErr)
		handles = nil // tolerated by channelSummaryFromStore
	}
	cwm := store.ChannelWithMembers{Channel: ch, MemberIDs: memberIDs}
	summary := channelSummaryFromStore(cwm, handles)
	for _, uid := range addUserIDs {
		if err := h.publishChannelEvent(ctx, uid, channelID, "added", summary); err != nil {
			h.logger.Printf("publishMlsAddChannelEvents: publish to %s: %v",
				uid, err)
		}
	}
}


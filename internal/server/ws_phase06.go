package server

// This file holds the phase-06 frame handlers: presence and friend
// operations. The main ws.go file (from phase 05, refreshed in this
// phase) routes incoming frame types to these handlers. Kept separate
// from ws.go so the diff against phase 05 is visible and reviewable.

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/friends"
	"github.com/scuq/chalk/internal/presence"
	"github.com/scuq/chalk/internal/proto"
)

// presenceHeartbeatTicker is set up per-connection. The cadence depends
// on the device_type declared in the hello. Each tick bumps last_seen
// in device_presence so the demotion sweep doesn't downgrade us.
//
// We don't republish state on every heartbeat; only when state changes.
// That keeps NOTIFY traffic proportional to actual user activity.
func (h *WSHandler) startPresenceHeartbeat(
	ctx context.Context,
	deviceID uuid.UUID,
	dt presence.DeviceType,
) {
	if h.presence == nil {
		return
	}
	interval := dt.HeartbeatInterval()
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			bumpCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			err := h.presence.BumpLastSeen(bumpCtx, deviceID)
			cancel()
			if err != nil && !errors.Is(err, presence.ErrDeviceNotPresent) {
				h.logger.Printf("presence heartbeat: %v", err)
			}
			// If the row was missing (janitor reaped us or a state
			// change cleared it), re-establish online. The client
			// expects to still be "present" because the WebSocket
			// itself is still open.
			if errors.Is(err, presence.ErrDeviceNotPresent) {
				reCtx, reCancel := context.WithTimeout(ctx, 2*time.Second)
				_ = h.presence.SetDevicePresence(reCtx, presence.DevicePresence{
					DeviceID:   deviceID,
					UserID:     h.lookupUserForDevice(reCtx, deviceID),
					InstanceID: h.instanceID,
					DeviceType: dt,
					State:      presence.StateOnline,
				})
				reCancel()
			}
		}
	}
}

// lookupUserForDevice returns the user_id for a device. Best-effort;
// returns uuid.Nil if the device isn't in the devices table (which
// shouldn't happen since ensureDeviceForTesting creates one in phase 05).
func (h *WSHandler) lookupUserForDevice(ctx context.Context, deviceID uuid.UUID) uuid.UUID {
	if h.store == nil {
		return uuid.Nil
	}
	var u uuid.UUID
	err := h.store.Pool.QueryRow(ctx,
		`SELECT user_id FROM devices WHERE id = $1`, deviceID,
	).Scan(&u)
	if err != nil {
		return uuid.Nil
	}
	return u
}

// handlePresenceSubscribe records subscriptions for the calling device
// and sends back the per-user accepted/rejected breakdown.
func (h *WSHandler) handlePresenceSubscribe(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.PresenceSubscribePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}

	myDevice, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	myUser := h.lookupUserForDevice(ctx, myDevice)
	if myUser == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}

	subscribed := []string{}
	rejected := []proto.PresenceRejection{}
	for _, idStr := range p.UserIDs {
		target, err := uuid.Parse(idStr)
		if err != nil {
			rejected = append(rejected, proto.PresenceRejection{
				UserID: idStr, Reason: proto.ErrCodeBadPayload,
			})
			continue
		}
		if target == myUser {
			rejected = append(rejected, proto.PresenceRejection{
				UserID: idStr, Reason: "self",
			})
			continue
		}
		if err := h.friends.AssertActive(ctx, target); err != nil {
			rejected = append(rejected, proto.PresenceRejection{
				UserID: idStr, Reason: proto.ErrCodeUserNotFound,
			})
			continue
		}
		ok, err := h.friends.AreAcceptedFriends(ctx, myUser, target)
		if err != nil {
			rejected = append(rejected, proto.PresenceRejection{
				UserID: idStr, Reason: proto.ErrCodeInternal,
			})
			continue
		}
		if !ok {
			rejected = append(rejected, proto.PresenceRejection{
				UserID: idStr, Reason: proto.ErrCodeNotFriends,
			})
			continue
		}
		if err := h.presence.AddSubscription(ctx, myDevice, target); err != nil {
			rejected = append(rejected, proto.PresenceRejection{
				UserID: idStr, Reason: proto.ErrCodeInternal,
			})
			continue
		}
		subscribed = append(subscribed, idStr)
	}

	ack, _ := proto.NewFrame(proto.TypePresenceSubscribeAck, f.Ref,
		proto.PresenceSubscribeAckPayload{
			Subscribed: subscribed,
			Rejected:   rejected,
		})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	// For each successful subscription, immediately push the target's
	// current aggregated state so the client doesn't have to wait for
	// the next transition.
	for _, idStr := range subscribed {
		target, _ := uuid.Parse(idStr)
		state, at, err := h.presence.AggregateUserState(ctx, target)
		if err != nil {
			continue
		}
		push, _ := proto.NewFrame(proto.TypePresence, "",
			proto.PresencePayload{
				UserID: idStr,
				State:  string(state),
				At:     at.UnixMilli(),
			})
		pd, _ := json.Marshal(push)
		_ = writeOne(ctx, c, pd, h.cfg.WriteTimeout)
	}
}

// handlePresenceUnsubscribe removes subscriptions.
func (h *WSHandler) handlePresenceUnsubscribe(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.PresenceUnsubscribePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	myDevice, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}

	unsubscribed := []string{}
	for _, idStr := range p.UserIDs {
		target, err := uuid.Parse(idStr)
		if err != nil {
			continue
		}
		_ = h.presence.RemoveSubscription(ctx, myDevice, target)
		unsubscribed = append(unsubscribed, idStr)
	}

	ack, _ := proto.NewFrame(proto.TypePresenceUnsubscribeAck, f.Ref,
		proto.PresenceUnsubscribeAckPayload{Unsubscribed: unsubscribed})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

// handlePresenceUpdate records the client's claimed state. The server
// applies the change to the device's row and may republish if it
// represents a transition; otherwise it's a heartbeat-with-intent.
func (h *WSHandler) handlePresenceUpdate(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.PresenceUpdatePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	// Clients can only claim online or away. offline is server-enforced
	// on disconnect or by the demotion sweep.
	if p.State != string(presence.StateOnline) && p.State != string(presence.StateAway) {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInvalidState,
			"clients may only claim online or away")
		return
	}
	myDevice, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}

	prev, err := h.presence.SetDeviceState(ctx, myDevice, presence.State(p.State))
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, err.Error())
		return
	}

	ack, _ := proto.NewFrame(proto.TypePresenceUpdateAck, f.Ref,
		proto.PresenceUpdateAckPayload{State: p.State})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	// Publish NOTIFY only on actual transitions.
	if string(prev) != p.State {
		userID := h.lookupUserForDevice(ctx, myDevice)
		if userID != uuid.Nil && h.publishPresenceChange != nil {
			pubCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			defer cancel()
			if err := h.publishPresenceChange(pubCtx, userID); err != nil {
				h.logger.Printf("publish presence change: %v", err)
			}
		}
	}
}

// --- friend handlers ---------------------------------------------------

func (h *WSHandler) handleFriendRequest(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.FriendRequestPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	from, to, ok := h.parseUserPair(ctx, c, f.Ref, conn.DeviceID, p.ToUserID)
	if !ok {
		return
	}

	outcome, err := h.friends.Request(ctx, from, to)
	if err != nil {
		h.sendFriendError(ctx, c, f.Ref, err)
		return
	}

	ack, _ := proto.NewFrame(proto.TypeFriendRequestAck, f.Ref,
		proto.FriendRequestAckPayload{
			ToUserID: p.ToUserID,
			Status:   outcome,
		})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	// Notify the other party so their connected devices learn about
	// the event in real time.
	kind := "request_received"
	if outcome == "auto_accepted" {
		kind = "accepted"
	}
	h.publishFriendEvent(ctx, to, from, kind)

	// If auto-accepted, also notify the requester (us). The wire push
	// is useful for multi-device users: another device of mine should
	// learn this friendship became accepted.
	if outcome == "auto_accepted" {
		h.publishFriendEvent(ctx, from, to, "accepted")
	}
}

func (h *WSHandler) handleFriendAccept(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.FriendAcceptPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	us, from, ok := h.parseUserPair(ctx, c, f.Ref, conn.DeviceID, p.FromUserID)
	if !ok {
		return
	}
	if err := h.friends.Accept(ctx, us, from); err != nil {
		h.sendFriendError(ctx, c, f.Ref, err)
		return
	}
	ack, _ := proto.NewFrame(proto.TypeFriendAcceptAck, f.Ref,
		proto.FriendAcceptAckPayload{FromUserID: p.FromUserID})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)

	// Push to the requester so their UI updates immediately.
	h.publishFriendEvent(ctx, from, us, "accepted")
}

func (h *WSHandler) handleFriendDecline(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.FriendDeclinePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	us, from, ok := h.parseUserPair(ctx, c, f.Ref, conn.DeviceID, p.FromUserID)
	if !ok {
		return
	}
	if err := h.friends.Decline(ctx, us, from); err != nil {
		h.sendFriendError(ctx, c, f.Ref, err)
		return
	}
	ack, _ := proto.NewFrame(proto.TypeFriendDeclineAck, f.Ref,
		proto.FriendDeclineAckPayload{FromUserID: p.FromUserID})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
	h.publishFriendEvent(ctx, from, us, "declined")
}

func (h *WSHandler) handleFriendRemove(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.FriendRemovePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	us, them, ok := h.parseUserPair(ctx, c, f.Ref, conn.DeviceID, p.UserID)
	if !ok {
		return
	}
	if err := h.friends.Remove(ctx, us, them); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeFriendRemoveAck, f.Ref,
		proto.FriendRemoveAckPayload{UserID: p.UserID})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
	h.publishFriendEvent(ctx, them, us, "removed")
}

func (h *WSHandler) handleFriendBlock(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.FriendBlockPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	us, them, ok := h.parseUserPair(ctx, c, f.Ref, conn.DeviceID, p.UserID)
	if !ok {
		return
	}
	if err := h.friends.Block(ctx, us, them); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeFriendBlockAck, f.Ref,
		proto.FriendBlockAckPayload{UserID: p.UserID})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
	// Per design: blocked party is NOT notified.
}

func (h *WSHandler) handleFriendUnblock(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	var p proto.FriendUnblockPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	us, them, ok := h.parseUserPair(ctx, c, f.Ref, conn.DeviceID, p.UserID)
	if !ok {
		return
	}
	if err := h.friends.Unblock(ctx, us, them); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeFriendUnblockAck, f.Ref,
		proto.FriendUnblockAckPayload{UserID: p.UserID})
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

func (h *WSHandler) handleFriendList(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	if !h.requirePresenceAndFriends(ctx, c, f.Ref) {
		return
	}
	myDevice, err := uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return
	}
	myUser := h.lookupUserForDevice(ctx, myDevice)
	if myUser == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "unknown user")
		return
	}

	entries, err := h.friends.List(ctx, myUser)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, err.Error())
		return
	}

	// Hydrate handles + account statuses in one query.
	summaries, err := h.hydrateSummaries(ctx, entries)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, err.Error())
		return
	}

	out := proto.FriendListAckPayload{}
	for _, e := range entries {
		s := summaries[e.OtherUserID]
		switch {
		case e.Status == friends.StatusPending && e.Direction == "outgoing":
			out.PendingOutgoing = append(out.PendingOutgoing, s)
		case e.Status == friends.StatusPending && e.Direction == "incoming":
			out.PendingIncoming = append(out.PendingIncoming, s)
		case e.Status == friends.StatusAccepted:
			out.Accepted = append(out.Accepted, s)
		case e.Status == friends.StatusBlocked:
			out.Blocked = append(out.Blocked, s)
		}
	}

	ack, _ := proto.NewFrame(proto.TypeFriendListAck, f.Ref, out)
	data, _ := json.Marshal(ack)
	_ = writeOne(ctx, c, data, h.cfg.WriteTimeout)
}

// hydrateSummaries fetches handle + status for the OtherUserID of every
// entry in one query, then returns a map. Phase 06 sees small friend
// lists (typical user has tens, not thousands), so the IN-list approach
// is fine.
func (h *WSHandler) hydrateSummaries(
	ctx context.Context,
	entries []friends.FriendListEntry,
) (map[uuid.UUID]proto.FriendSummary, error) {
	if len(entries) == 0 {
		return map[uuid.UUID]proto.FriendSummary{}, nil
	}
	ids := make([]uuid.UUID, 0, len(entries))
	seen := make(map[uuid.UUID]struct{}, len(entries))
	for _, e := range entries {
		if _, ok := seen[e.OtherUserID]; ok {
			continue
		}
		seen[e.OtherUserID] = struct{}{}
		ids = append(ids, e.OtherUserID)
	}

	rows, err := h.store.Pool.Query(ctx,
		`SELECT id, handle, status FROM users WHERE id = ANY($1)`,
		ids,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make(map[uuid.UUID]proto.FriendSummary, len(ids))
	for rows.Next() {
		var id uuid.UUID
		var handle, status string
		if err := rows.Scan(&id, &handle, &status); err != nil {
			return nil, err
		}
		out[id] = proto.FriendSummary{
			UserID:        id.String(),
			Handle:        handle,
			AccountStatus: status,
		}
	}
	return out, rows.Err()
}

// --- helpers ----------------------------------------------------------

// parseUserPair resolves both the caller's user_id (from their device_id)
// and a target user_id from the request. Sends an appropriate error frame
// and returns ok=false on failure.
func (h *WSHandler) parseUserPair(
	ctx context.Context,
	c *websocket.Conn,
	ref, deviceIDStr, targetUserIDStr string,
) (us, target uuid.UUID, ok bool) {
	deviceID, err := uuid.Parse(deviceIDStr)
	if err != nil {
		h.sendError(ctx, c, ref, proto.ErrCodeBadPayload, "device_id not a UUID")
		return uuid.Nil, uuid.Nil, false
	}
	us = h.lookupUserForDevice(ctx, deviceID)
	if us == uuid.Nil {
		h.sendError(ctx, c, ref, proto.ErrCodeInternal, "unknown user")
		return uuid.Nil, uuid.Nil, false
	}
	target, err = uuid.Parse(targetUserIDStr)
	if err != nil {
		h.sendError(ctx, c, ref, proto.ErrCodeBadPayload, "user_id not a UUID")
		return uuid.Nil, uuid.Nil, false
	}
	if target == us {
		h.sendError(ctx, c, ref, proto.ErrCodeCannotSelfFriend,
			"cannot operate on self")
		return uuid.Nil, uuid.Nil, false
	}
	return us, target, true
}

// sendFriendError maps friends-package errors to wire error codes.
func (h *WSHandler) sendFriendError(
	ctx context.Context,
	c *websocket.Conn,
	ref string,
	err error,
) {
	code := proto.ErrCodeInternal
	switch {
	case errors.Is(err, friends.ErrSelfFriend):
		code = proto.ErrCodeCannotSelfFriend
	case errors.Is(err, friends.ErrUserNotFound),
		errors.Is(err, friends.ErrUserUnavailable):
		code = proto.ErrCodeUserNotFound
	case errors.Is(err, friends.ErrAlreadyFriends):
		code = proto.ErrCodeAlreadyFriends
	case errors.Is(err, friends.ErrBlocked):
		code = proto.ErrCodeFriendshipBlocked
	case errors.Is(err, friends.ErrNoPendingRequest):
		code = proto.ErrCodeNoPendingRequest
	}
	h.sendError(ctx, c, ref, code, err.Error())
}

// publishFriendEvent NOTIFYs interested parties about an asynchronous
// friendship state change. recipient is the user_id whose devices
// should receive the push; fromUser is the other party.
func (h *WSHandler) publishFriendEvent(
	ctx context.Context,
	recipient, fromUser uuid.UUID,
	kind string,
) {
	if h.publishFriend == nil {
		return
	}
	pubCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if err := h.publishFriend(pubCtx, recipient, fromUser, kind); err != nil {
		h.logger.Printf("publish friend event: %v", err)
	}
}

// requirePresenceAndFriends returns false (and emits an error frame) if
// the handler was constructed without the presence/friends dependencies.
// Defensive: prevents nil dereferences in tests that wire only part of
// the stack.
func (h *WSHandler) requirePresenceAndFriends(
	ctx context.Context,
	c *websocket.Conn,
	ref string,
) bool {
	if h.presence == nil || h.friends == nil {
		h.sendError(ctx, c, ref, proto.ErrCodeInternal,
			"presence/friends not configured on this server")
		return false
	}
	return true
}

// classifyDeviceType maps the client-claimed device_type string to a
// validated presence.DeviceType, defaulting to browser-unknown for any
// unrecognized value (including empty).
func classifyDeviceType(s string) presence.DeviceType {
	switch s {
	case string(presence.DevicePhone):
		return presence.DevicePhone
	case string(presence.DeviceTablet):
		return presence.DeviceTablet
	case string(presence.DeviceDesktop):
		return presence.DeviceDesktop
	}
	return presence.DeviceBrowserUnknown
}

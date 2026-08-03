package server

// Phase 09d-1: admin moderation needs a way to terminate every active
// WebSocket connection bound to a user, used by the block/soft-delete
// /purge admin endpoints.
//
// This file adds CloseConnsForUser to *Hub. It satisfies the
// auth.ConnKicker interface that the admin HTTP handlers depend on,
// so the wiring in cmd/chalkd looks like:
//
//   authDeps.Kicker = srv.Hub()
//
// The implementation reuses ConnsForUser (snapshot under the hub
// lock) and then closes each connection out-of-band. Closing is
// non-blocking from the caller's perspective: the WS read loop
// catches the close and runs Unregister itself, which is the normal
// teardown path.

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
)

// errRoomExpired is the goodbye reason for guest connections whose room the
// expiry janitor just purged (80-14). The guest client matches on the text
// to show its "this room has ended" screen.
var errRoomExpired = errors.New("room expired")

// CloseConnsForUser closes every WS connection bound to userID. The
// reason is propagated to each Conn.Close so the websocket goodbye
// frame carries it. Callers should pass a descriptive error (e.g.
// "blocked by admin alice") so the log audit trail is informative.
//
// Idempotent: closing an already-closed conn is a no-op at the Conn
// layer. Calling with an unknown userID is a no-op.
//
// Concurrency: the snapshot is taken under the hub lock (via
// ConnsForUser); the close calls happen without holding the hub
// lock so a slow close can't stall other hub operations.
func (h *Hub) CloseConnsForUser(userID string, reason error) {
	if userID == "" {
		return
	}
	if reason == nil {
		reason = errors.New("closed by admin moderation")
	}
	conns := h.ConnsForUser(userID)
	for _, c := range conns {
		c.Close(reason)
	}
}

// Hub returns the *Hub embedded in the Server, so callers like
// cmd/chalkd can wire it into auth.HTTPDeps.Kicker without
// duplicating Server.hub via a separate option. Read-only accessor.
func (s *Server) Hub() *Hub {
	return s.hub
}

// NotifyGuestJoined pushes channel_event{kind:"member_added"} to a room's
// members after a guest's FIRST redemption (80-14 aftermath of the 80-8
// join): without it, members' clients show the guest's messages under a
// UUID stub until their next reconnect. Wired into auth.HTTPDeps like
// Kicker. Best-effort: failures are logged, the redemption stands.
func (s *Server) NotifyGuestJoined(channelID, guestID uuid.UUID) {
	if s.wsh == nil || s.store == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	ch, err := s.store.GetChannel(ctx, channelID)
	if err != nil {
		s.logger.Printf("guest joined push: load channel: %v", err)
		return
	}
	members, err := s.store.ListMembersForChannel(ctx, channelID)
	if err != nil {
		s.logger.Printf("guest joined push: list members: %v", err)
		return
	}
	summary := s.wsh.channelEventSummary(ctx, ch, members)
	for _, m := range members {
		if m == guestID {
			continue
		}
		if err := s.wsh.publishChannelEvent(ctx, m, channelID, "member_added", summary); err != nil {
			s.logger.Printf("guest joined push to %s: %v", m, err)
		}
	}
}

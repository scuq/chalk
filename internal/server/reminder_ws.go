package server

// 87-7: the reminder wake frame, reminder_wakes_set
// (internal/proto/reminder.go).
//
// The wake set belongs to the user behind the connection, never to a user
// named in the frame. The server refuses the frame on a connection without a
// sealed channel, for a guest or a connection without a login session, and on
// a server with push off. The error codes are the codes of the push frames.
// A refused frame leaves the stored set unchanged.

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/store"
)

// maxReminderWakeDueMs is the latest due time the server accepts: the start
// of the year 10000 in milliseconds since the Unix epoch.
const maxReminderWakeDueMs = 253402300800000

// handleReminderWakesSet replaces the wake set of the user and answers with
// the number of stored records.
func (h *WSHandler) handleReminderWakesSet(ctx context.Context, c *websocket.Conn, conn *Conn, f proto.Frame) {
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return
	}
	if _, sealed := innerSessions.Load(c); !sealed {
		h.sendError(ctx, c, f.Ref, proto.ErrCodePushUnsealed, "reminder wakes need the sealed channel")
		return
	}
	userID, err := uuid.Parse(conn.UserID)
	if conn.IsGuest || len(conn.SessionToken) == 0 || err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodePushNoSession, "no login session")
		return
	}
	if h.push == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodePushDisabled, "push is disabled on this server")
		return
	}
	var p proto.ReminderWakesSetPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	wakes, msg := parseReminderWakes(p)
	if msg != "" {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, msg)
		return
	}
	stored, err := h.store.ReplaceReminderWakes(ctx, userID, wakes)
	if errors.Is(err, store.ErrNotFound) {
		h.sendError(ctx, c, f.Ref, proto.ErrCodePushNoSession, "the login session ended")
		return
	}
	if err != nil {
		h.logger.Printf("ws reminder_wakes_set: %v", err)
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "store failure")
		return
	}
	frame, _ := proto.NewFrame(proto.TypeReminderWakesSetAck, f.Ref, proto.ReminderWakesAckPayload{Stored: stored})
	data, _ := json.Marshal(frame)
	if err := writeOne(ctx, c, data, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("ws send %s: %v", proto.TypeReminderWakesSetAck, err)
	}
}

// parseReminderWakes validates a reminder_wakes_set payload. It returns the
// records, or a message that says what is wrong. A payload is wrong if it has
// more than proto.MaxReminderWakes records, an ID that is not a UUID, an ID
// that occurs twice, or a due time that is not after the epoch and before
// the year 10000.
func parseReminderWakes(p proto.ReminderWakesSetPayload) ([]store.ReminderWake, string) {
	if len(p.Wakes) > proto.MaxReminderWakes {
		return nil, "too many reminder wakes"
	}
	seen := make(map[uuid.UUID]struct{}, len(p.Wakes))
	out := make([]store.ReminderWake, 0, len(p.Wakes))
	for _, w := range p.Wakes {
		id, err := uuid.Parse(w.ID)
		if err != nil {
			return nil, "reminder id is not a UUID"
		}
		if _, dup := seen[id]; dup {
			return nil, "reminder id occurs twice"
		}
		seen[id] = struct{}{}
		if w.DueAt <= 0 || w.DueAt >= maxReminderWakeDueMs {
			return nil, "due time out of range"
		}
		out = append(out, store.ReminderWake{ReminderID: id, DueAt: time.UnixMilli(w.DueAt).UTC()})
	}
	return out, ""
}

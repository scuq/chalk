package server

// Phase 43-3: consumer side of the typing push. A Kind="typing" event arrives
// on the per-channel topic; we name the typist to everyone else in the channel.
//
// This does not reuse broadcastToChannelMembers, for two reasons that both cut
// the same way:
//
//   - It excludes by CONN id, deliberately: for a message or a reaction, the
//     sender's other devices must receive the push. Typing is the one event
//     where the opposite holds -- your phone must never say you are typing.
//     So the exclusion here is per USER, and the conn id is redundant.
//   - It gates on freshness (skip conns registered after the event's ts).
//     For a "happening now" event that gate is a no-op with a race attached:
//     a conn registered microseconds later would be skipped for nothing. A
//     typing ping is only meaningful now, and a just-connected client is
//     exactly the one that should see it.
//
// The event carries its whole meaning, so unlike the read/message consumers
// there is nothing to re-fetch -- just the one indexed membership query. Keep
// it that way: this runs on the same single goroutine that delivers messages
// (pubsub.Listener), and typing raises the event rate.

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
)

func (s *Server) handleTypingEvent(ev pubsub.Event) {
	if s.store == nil || ev.UserID == uuid.Nil || ev.ChannelID == uuid.Nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	members, err := s.store.ListMembersForChannel(ctx, ev.ChannelID)
	if err != nil {
		s.logger.Printf("typing event members %s: %v", ev.ChannelID, err)
		return
	}

	threadID := ""
	if ev.ThreadID != uuid.Nil {
		threadID = ev.ThreadID.String()
	}
	frame, err := proto.NewFrame(proto.TypeTypingUpdate, "", proto.TypingUpdatePayload{
		ChannelID: ev.ChannelID.String(),
		ThreadID:  threadID,
		UserID:    ev.UserID.String(),
	})
	if err != nil {
		s.logger.Printf("typing event frame: %v", err)
		return
	}
	wire, err := json.Marshal(frame)
	if err != nil {
		s.logger.Printf("typing event marshal: %v", err)
		return
	}

	// A conn whose send buffer is full gets closed by FanOutToUser, same as
	// every other push. Typing can only ever be the straw: the buffer is 64
	// deep and drained continuously, so it is not full unless that writer was
	// already stalled.
	for _, m := range members {
		if m == ev.UserID {
			continue
		}
		s.hub.FanOutToUser(m.String(), "", wire)
	}
}

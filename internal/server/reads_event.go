package server

// Phase 33-1: consumer side of the read-cursor push. A Kind="read" event on
// chalk_global names a user and a channel; we re-read the cursor from the
// store and push read_state to that user's local conns, skipping the one
// that made the change.
//
// The cursor is re-read rather than carried in the event so that two
// devices marking read at once converge on the stored (monotonic) value
// instead of on whichever NOTIFY happened to arrive last.

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
)

func (s *Server) handleReadEvent(ev pubsub.Event) {
	if s.store == nil || ev.UserID == uuid.Nil || ev.ChannelID == uuid.Nil {
		return
	}
	if len(s.hub.ConnsForUser(ev.UserID.String())) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	seq, err := s.store.GetChannelRead(ctx, ev.ChannelID, ev.UserID)
	if err != nil {
		s.logger.Printf("read event fetch: %v", err)
		return
	}
	frame, _ := proto.NewFrame(proto.TypeReadState, "", proto.ReadStatePayload{
		ChannelID:   ev.ChannelID.String(),
		LastReadSeq: seq,
	})
	wire, _ := json.Marshal(frame)
	s.hub.FanOutToUser(ev.UserID.String(), ev.SenderConnID, wire)
}

package server

// gov-1b-1: consumer side of governance pushes. A governance Event published on
// chalk_global (Kind="governance") carries the GovernanceEventPayload JSON in
// the opaque ChannelEventPayload slot and the sub-kind in FriendKind. We unwrap
// and fan a governance_event frame out to the recipient's local connections,
// mirroring handleChannelEvent.

import (
	"encoding/json"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
)

func (s *Server) handleGovernanceEvent(ev pubsub.Event) {
	if ev.UserID == uuid.Nil {
		return
	}
	var payload proto.GovernanceEventPayload
	if len(ev.ChannelEventPayload) > 0 {
		if err := json.Unmarshal(ev.ChannelEventPayload, &payload); err != nil {
			s.logger.Printf("governance event decode: %v", err)
			return
		}
	}
	// FriendKind is authoritative for the sub-kind; keep payload.Kind in sync.
	if ev.FriendKind != "" {
		payload.Kind = ev.FriendKind
	}

	frame, err := proto.NewFrame(proto.TypeGovernanceEvent, "", payload)
	if err != nil {
		s.logger.Printf("governance event frame: %v", err)
		return
	}
	wire, err := json.Marshal(frame)
	if err != nil {
		s.logger.Printf("governance event marshal: %v", err)
		return
	}
	s.hub.FanOutToUser(ev.UserID.String(), "", wire)
}

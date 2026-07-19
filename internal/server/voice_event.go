package server

// 30-2: consumer side of voice pushes. A Kind="voice" Event on chalk_global
// carries the push JSON in the opaque ChannelEventPayload slot and the
// sub-kind in FriendKind (joined | left | state | signal). We unwrap and fan
// the matching voice frame out to the recipient's LOCAL connections --
// mirroring handleGovernanceEvent -- with one twist: "signal" is addressed to
// ONE device, so it goes only to that device's conns, not all of the user's.

import (
	"encoding/json"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
)

func (s *Server) handleVoiceEvent(ev pubsub.Event) {
	if ev.UserID == uuid.Nil || len(ev.ChannelEventPayload) == 0 {
		return
	}

	var (
		frameType string
		payload   any
	)
	switch ev.FriendKind {
	case "joined":
		var p proto.VoiceParticipantJoinedPayload
		if err := json.Unmarshal(ev.ChannelEventPayload, &p); err != nil {
			s.logger.Printf("voice event decode (joined): %v", err)
			return
		}
		frameType, payload = proto.TypeVoiceParticipantJoined, p
	case "left":
		var p proto.VoiceParticipantLeftPayload
		if err := json.Unmarshal(ev.ChannelEventPayload, &p); err != nil {
			s.logger.Printf("voice event decode (left): %v", err)
			return
		}
		frameType, payload = proto.TypeVoiceParticipantLeft, p
	case "state":
		var p proto.VoiceParticipantStatePayload
		if err := json.Unmarshal(ev.ChannelEventPayload, &p); err != nil {
			s.logger.Printf("voice event decode (state): %v", err)
			return
		}
		frameType, payload = proto.TypeVoiceParticipantState, p
	case "signal":
		s.handleVoiceSignalEvent(ev)
		return
	default:
		return
	}

	frame, err := proto.NewFrame(frameType, "", payload)
	if err != nil {
		s.logger.Printf("voice event frame: %v", err)
		return
	}
	wire, err := json.Marshal(frame)
	if err != nil {
		s.logger.Printf("voice event marshal: %v", err)
		return
	}
	s.hub.FanOutToUser(ev.UserID.String(), "", wire)
}

// handleVoiceSignalEvent delivers a relayed voice_signal to exactly the
// target DEVICE's local conns (all tabs of that device). The envelope's Push
// payload is the sender's opaque ciphertext; it is forwarded untouched and
// never logged.
func (s *Server) handleVoiceSignalEvent(ev pubsub.Event) {
	var env voiceSignalEnvelope
	if err := json.Unmarshal(ev.ChannelEventPayload, &env); err != nil {
		s.logger.Printf("voice event decode (signal envelope): %v", err)
		return
	}
	if env.ToDevice == "" {
		return
	}
	frame, err := proto.NewFrame(proto.TypeVoiceSignal, "", env.Push)
	if err != nil {
		s.logger.Printf("voice signal frame: %v", err)
		return
	}
	wire, err := json.Marshal(frame)
	if err != nil {
		s.logger.Printf("voice signal marshal: %v", err)
		return
	}
	for _, c := range s.hub.ConnsForUser(ev.UserID.String()) {
		if c.DeviceID != env.ToDevice {
			continue
		}
		// Enqueue mirrors FanOutToUser: a full/blocked conn is closed rather
		// than blocking the pubsub pump; WebRTC signaling is renegotiated at
		// the client layer on reconnect.
		if err := c.Enqueue(wire); err != nil {
			go c.Close(err)
		}
	}
}

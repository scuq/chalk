package server

// 30-2/30-4d: consumer side of voice pushes. A Kind="voice" Event on
// chalk_global carries the sub-kind in FriendKind (joined | left | state |
// signal). Roster deltas (joined/left/state) are tiny and ride inline in the
// opaque ChannelEventPayload slot; "signal" payloads are too large for a
// NOTIFY (PG's 8000-byte cap) so the event is a routing pointer (MessageID =
// voice_signal_spool row id) and the ciphertext is fetched from the spool.
// Fan-out goes to the recipient's LOCAL connections -- mirroring
// handleGovernanceEvent -- with one twist: "signal" is addressed to ONE
// device, so it goes only to that device's conns, not all of the user's.

import (
	"context"
	"encoding/json"
	"time"

	"github.com/google/uuid"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
)

func (s *Server) handleVoiceEvent(ev pubsub.Event) {
	if ev.UserID == uuid.Nil {
		return
	}
	// 30-4d: "signal" is a routing pointer with NO inline payload -- route it
	// before the payload-presence check that guards the inline sub-kinds.
	if ev.FriendKind == "signal" {
		s.handleVoiceSignalEvent(ev)
		return
	}
	if len(ev.ChannelEventPayload) == 0 {
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
// target DEVICE's local conns (all tabs of that device). 30-4d: the event is
// a routing pointer (MessageID = voice_signal_spool row id); the payload is
// fetched from the spool -- NOTIFY cannot carry it (8000-byte cap). The
// fetched ciphertext is forwarded untouched and never logged.
//
// Fast exits keep the multi-instance cost tiny: an instance with no conns for
// the recipient never even queries the spool.
func (s *Server) handleVoiceSignalEvent(ev pubsub.Event) {
	if ev.MessageID == uuid.Nil {
		return
	}
	conns := s.hub.ConnsForUser(ev.UserID.String())
	if len(conns) == 0 {
		return // recipient not on this instance
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	row, err := s.store.FetchVoiceSignal(ctx, ev.MessageID)
	if err != nil {
		// Already swept (recipient was offline past the TTL) or a stale
		// event. Signaling is renegotiated at the client layer on rejoin.
		s.logger.Printf("voice signal fetch %s: %v", ev.MessageID, err)
		return
	}
	toDevice := row.ToDevice.String()
	frame, err := proto.NewFrame(proto.TypeVoiceSignal, "", proto.VoiceSignalPushPayload{
		ChannelID:  row.ChannelID.String(),
		FromUser:   row.FromUser.String(),
		FromDevice: row.FromDevice.String(),
		Kind:       row.Kind,
		Payload:    json.RawMessage(row.Payload),
	})
	if err != nil {
		s.logger.Printf("voice signal frame: %v", err)
		return
	}
	wire, err := json.Marshal(frame)
	if err != nil {
		s.logger.Printf("voice signal marshal: %v", err)
		return
	}
	for _, c := range conns {
		if c.DeviceID != toDevice {
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

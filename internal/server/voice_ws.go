package server

// Voice signaling handlers (Phase 30, slice 30-2; design §4/§5). The server is
// a ROUTER: it owns room membership rows (store/voice.go, 30-1), mints TURN
// creds on join, fans roster deltas to channel members, and relays
// voice_signal blobs peer->peer by (to_user, to_device). The signal payload is
// E2E ciphertext -- never inspected, never logged.
//
// Cross-instance: every push rides the governance-event pattern -- a
// Kind="voice" pubsub event per recipient with the JSON in the opaque
// ChannelEventPayload slot and the sub-kind in FriendKind. The consumer side
// (voice_event.go) fans out to the recipient's local conns, filtering to one
// device for "signal". voice_participants.conn_id is stored INSTANCE-PREFIXED
// ("<instanceID>:<connID>") so each instance's janitor sweeps only its own
// orphans (see SweepVoiceOrphans).

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"github.com/scuq/chalk/internal/proto"
	"github.com/scuq/chalk/internal/pubsub"
	"github.com/scuq/chalk/internal/store"
	"github.com/scuq/chalk/internal/turncred"
)

// VoiceWSConfig carries the voice knobs into the WS layer. Populated in
// cmd/chalkd from config.VoiceConfig (the server package stays decoupled from
// internal/config, same as AttachMaxPerMessage).
type VoiceWSConfig struct {
	Enabled         bool
	MaxParticipants int
	ForceRelay      bool
	TurnURLs        []string
	TurnSecret      string
	TurnTTL         time.Duration
	StunURLs        []string
}

// voiceConnID is the instance-scoped conn key stored in voice_participants.
func voiceConnID(instanceID, connID string) string {
	return instanceID + ":" + connID
}

// voiceCallerFor resolves the calling (user, device) or writes the error and
// returns ok=false. Shared preamble of all five voice handlers.
func (h *WSHandler) voiceCallerFor(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) (userID, deviceID uuid.UUID, ok bool) {
	if !h.cfg.Voice.Enabled {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeVoiceDisabled,
			"voice is disabled on this server (CHALK_VOICE_ENABLED)")
		return uuid.Nil, uuid.Nil, false
	}
	if h.store == nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "no store configured")
		return uuid.Nil, uuid.Nil, false
	}
	var err error
	deviceID, err = uuid.Parse(conn.DeviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "device_id invalid")
		return uuid.Nil, uuid.Nil, false
	}
	userID = h.lookupUserForDevice(ctx, deviceID)
	if userID == uuid.Nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember,
			"anonymous senders cannot use voice")
		return uuid.Nil, uuid.Nil, false
	}
	return userID, deviceID, true
}

// requireVoiceMember parses the channel id and enforces channel membership.
func (h *WSHandler) requireVoiceMember(
	ctx context.Context,
	c *websocket.Conn,
	f proto.Frame,
	channelIDStr string,
	userID uuid.UUID,
) (uuid.UUID, bool) {
	channelID, err := uuid.Parse(channelIDStr)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "channel_id invalid")
		return uuid.Nil, false
	}
	member, err := h.store.IsMember(ctx, channelID, userID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "membership: "+err.Error())
		return uuid.Nil, false
	}
	if !member {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotAMember, "not a channel member")
		return uuid.Nil, false
	}
	return channelID, true
}

func voiceRosterView(rows []store.VoiceParticipant) []proto.VoiceParticipantView {
	out := make([]proto.VoiceParticipantView, 0, len(rows))
	for _, p := range rows {
		out = append(out, proto.VoiceParticipantView{
			UserID:   p.UserID.String(),
			DeviceID: p.DeviceID.String(),
			Muted:    p.Muted,
			VideoOn:  p.VideoOn,
			ScreenOn: p.ScreenOn,
		})
	}
	return out
}

// ---- voice_join ------------------------------------------------------------

func (h *WSHandler) handleVoiceJoin(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.VoiceJoinPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	userID, deviceID, ok := h.voiceCallerFor(ctx, c, conn, f)
	if !ok {
		return
	}
	channelID, ok := h.requireVoiceMember(ctx, c, f, p.ChannelID, userID)
	if !ok {
		return
	}

	roster, err := h.store.JoinVoice(ctx, channelID, userID, deviceID,
		voiceConnID(h.instanceID, conn.ID), h.cfg.Voice.MaxParticipants)
	switch {
	case errors.Is(err, store.ErrChannelNotFound):
		h.sendError(ctx, c, f.Ref, proto.ErrCodeChannelNotFound, "channel not found")
		return
	case errors.Is(err, store.ErrNotVoiceChannel):
		h.sendError(ctx, c, f.Ref, proto.ErrCodeNotVoiceChannel, "not a voice channel")
		return
	case errors.Is(err, store.ErrVoiceRoomFull):
		h.sendError(ctx, c, f.Ref, proto.ErrCodeVoiceRoomFull, "voice room is full")
		return
	case errors.Is(err, store.ErrVoiceDeviceConflict):
		h.sendError(ctx, c, f.Ref, proto.ErrCodeVoiceDeviceConflict,
			"already in this room from another device")
		return
	case err != nil:
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "join: "+err.Error())
		return
	}

	// Roster in the ack EXCLUDES the joiner: the joiner offers to exactly the
	// EXISTING peers (glare-free handshake, design §4).
	existing := make([]store.VoiceParticipant, 0, len(roster))
	for _, r := range roster {
		if r.UserID == userID && r.DeviceID == deviceID {
			continue
		}
		existing = append(existing, r)
	}

	// STUN-only degraded mode is legal but most clients won't connect; log it
	// once per join so the operator sees why calls fail (design §5).
	if len(h.cfg.Voice.TurnURLs) == 0 {
		h.logger.Printf("voice: join without TURN configured (STUN-only degraded mode)")
	}
	ice := turncred.ICEServers(
		h.cfg.Voice.StunURLs, h.cfg.Voice.TurnURLs,
		h.cfg.Voice.TurnSecret, userID.String(),
		h.cfg.Voice.TurnTTL, time.Now().UTC(),
	)
	iceView := make([]proto.ICEServer, 0, len(ice))
	for _, s := range ice {
		iceView = append(iceView, proto.ICEServer{
			URLs: s.URLs, Username: s.Username, Credential: s.Credential,
		})
	}

	ack, _ := proto.NewFrame(proto.TypeVoiceJoinAck, f.Ref, proto.VoiceJoinAckPayload{
		ChannelID:  channelID.String(),
		Roster:     voiceRosterView(existing),
		ICEServers: iceView,
		ForceRelay: h.cfg.Voice.ForceRelay,
	})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("voice_join_ack write: %v", err)
	}

	h.pushVoiceToMembers(ctx, channelID, "joined", proto.VoiceParticipantJoinedPayload{
		ChannelID: channelID.String(),
		UserID:    userID.String(),
		DeviceID:  deviceID.String(),
	})
}

// ---- voice_leave -----------------------------------------------------------

func (h *WSHandler) handleVoiceLeave(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.VoiceLeavePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	userID, deviceID, ok := h.voiceCallerFor(ctx, c, conn, f)
	if !ok {
		return
	}
	channelID, ok := h.requireVoiceMember(ctx, c, f, p.ChannelID, userID)
	if !ok {
		return
	}

	left, err := h.store.LeaveVoice(ctx, channelID, userID, deviceID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "leave: "+err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeVoiceLeaveAck, f.Ref, proto.VoiceLeaveAckPayload{
		ChannelID: channelID.String(),
		Left:      left,
	})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("voice_leave_ack write: %v", err)
	}
	if left {
		h.pushVoiceToMembers(ctx, channelID, "left", proto.VoiceParticipantLeftPayload{
			ChannelID: channelID.String(),
			UserID:    userID.String(),
			DeviceID:  deviceID.String(),
		})
	}
}

// ---- voice_roster ----------------------------------------------------------

func (h *WSHandler) handleVoiceRoster(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.VoiceRosterPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	userID, _, ok := h.voiceCallerFor(ctx, c, conn, f)
	if !ok {
		return
	}
	channelID, ok := h.requireVoiceMember(ctx, c, f, p.ChannelID, userID)
	if !ok {
		return
	}
	roster, err := h.store.VoiceRoster(ctx, channelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "roster: "+err.Error())
		return
	}
	ack, _ := proto.NewFrame(proto.TypeVoiceRosterAck, f.Ref, proto.VoiceRosterAckPayload{
		ChannelID: channelID.String(),
		Roster:    voiceRosterView(roster),
	})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("voice_roster_ack write: %v", err)
	}
}

// ---- voice_state -----------------------------------------------------------

func (h *WSHandler) handleVoiceState(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.VoiceStatePayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	userID, deviceID, ok := h.voiceCallerFor(ctx, c, conn, f)
	if !ok {
		return
	}
	channelID, ok := h.requireVoiceMember(ctx, c, f, p.ChannelID, userID)
	if !ok {
		return
	}
	updated, err := h.store.UpdateVoiceState(ctx, channelID, userID, deviceID,
		p.Muted, p.VideoOn, p.ScreenOn)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "state: "+err.Error())
		return
	}
	if !updated {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeVoiceNotInRoom, "not in the room")
		return
	}
	ack, _ := proto.NewFrame(proto.TypeVoiceStateAck, f.Ref, proto.VoiceStateAckPayload{
		ChannelID: channelID.String(),
	})
	if err := writeFrame(ctx, c, ack, h.cfg.WriteTimeout); err != nil {
		h.logger.Printf("voice_state_ack write: %v", err)
	}
	h.pushVoiceToMembers(ctx, channelID, "state", proto.VoiceParticipantStatePayload{
		ChannelID: channelID.String(),
		UserID:    userID.String(),
		DeviceID:  deviceID.String(),
		Muted:     p.Muted,
		VideoOn:   p.VideoOn,
		ScreenOn:  p.ScreenOn,
	})
}

// ---- voice_signal ----------------------------------------------------------

func (h *WSHandler) handleVoiceSignal(
	ctx context.Context,
	c *websocket.Conn,
	conn *Conn,
	f proto.Frame,
) {
	var p proto.VoiceSignalPayload
	if err := f.DecodePayload(&p); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, err.Error())
		return
	}
	userID, deviceID, ok := h.voiceCallerFor(ctx, c, conn, f)
	if !ok {
		return
	}
	channelID, ok := h.requireVoiceMember(ctx, c, f, p.ChannelID, userID)
	if !ok {
		return
	}
	toUser, err := uuid.Parse(p.ToUser)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "to_user invalid")
		return
	}
	toDevice, err := uuid.Parse(p.ToDevice)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "to_device invalid")
		return
	}
	switch p.Kind {
	case "offer", "answer", "ice", "screen_add", "screen_remove":
	default:
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "kind invalid")
		return
	}
	if len(p.Payload) == 0 {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeBadPayload, "payload required")
		return
	}

	// Both endpoints must be live participants of the room: signaling is a
	// participants-only surface (a member outside the room cannot probe it,
	// and blobs to absent devices are dropped here, not queued).
	roster, err := h.store.VoiceRoster(ctx, channelID)
	if err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "roster: "+err.Error())
		return
	}
	senderIn, targetIn := false, false
	for _, r := range roster {
		if r.UserID == userID && r.DeviceID == deviceID {
			senderIn = true
		}
		if r.UserID == toUser && r.DeviceID == toDevice {
			targetIn = true
		}
	}
	if !senderIn {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeVoiceNotInRoom, "sender not in the room")
		return
	}
	if !targetIn {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeVoiceNotInRoom, "target not in the room")
		return
	}

	// 30-4d: the encrypted payload is too large for a NOTIFY (PG's 8000-byte
	// cap; a camera-bearing offer exceeds it), so it is SPOOLED in the same
	// transaction as the publish and the event carries only the row id --
	// the fetch-on-notify pattern messages use. The consumer
	// (handleVoiceSignalEvent) fetches the row and delivers to the target
	// device's local conns.
	if err := h.publishVoiceSignal(ctx, store.VoiceSignalSpoolRow{
		ChannelID:  channelID,
		ToUser:     toUser,
		ToDevice:   toDevice,
		FromUser:   userID,
		FromDevice: deviceID,
		Kind:       p.Kind,
		Payload:    p.Payload, // opaque ciphertext; spooled untouched
	}); err != nil {
		h.sendError(ctx, c, f.Ref, proto.ErrCodeInternal, "relay failed")
		h.logger.Printf("voice signal publish: %v", err) // metadata only, never the payload
	}
}

// publishVoiceSignal spools one relayed signal and emits the tiny routing
// event (Kind="voice", FriendKind="signal", MessageID=<spool row id>) in one
// transaction, so the row is committed exactly when the NOTIFY fires.
func (h *WSHandler) publishVoiceSignal(
	ctx context.Context,
	r store.VoiceSignalSpoolRow,
) error {
	if h.store == nil {
		return errors.New("no store")
	}
	return pgxBegin(ctx, h.store, func(tx pgx.Tx) error {
		id, err := h.store.SpoolVoiceSignalTx(ctx, tx, r)
		if err != nil {
			return err
		}
		ev := pubsub.Event{
			Kind:       "voice",
			UserID:     r.ToUser,
			ChannelID:  r.ChannelID,
			InstanceID: h.instanceID,
			FriendKind: "signal",
			// MessageID doubles as the spool row id for sub-kind "signal"
			// (same slot-reuse as message events; documented in 0039).
			MessageID: id,
		}
		return pubsub.PublishWithTx(ctx, tx, ev)
	})
}

// ---- push plumbing ---------------------------------------------------------

// publishVoiceEvent emits one Kind="voice" pubsub event for one recipient,
// carrying payload JSON in the opaque ChannelEventPayload slot and the
// sub-kind (joined|left|state|signal) in FriendKind. Mirrors
// publishGovernanceEvent.
func (h *WSHandler) publishVoiceEvent(
	ctx context.Context,
	recipient, channelID uuid.UUID,
	kind string,
	payload any,
) error {
	if h.store == nil {
		return errors.New("no store")
	}
	return pgxBegin(ctx, h.store, func(tx pgx.Tx) error {
		buf, err := json.Marshal(payload)
		if err != nil {
			return err
		}
		ev := pubsub.Event{
			Kind:                "voice",
			UserID:              recipient,
			ChannelID:           channelID,
			InstanceID:          h.instanceID,
			FriendKind:          kind,
			ChannelEventPayload: buf,
		}
		return pubsub.PublishWithTx(ctx, tx, ev)
	})
}

// pushVoiceToMembers fans a roster-delta push to every current channel member
// (in-room or not, so sidebar occupancy stays live). Mirrors pushGovToMembers.
func (h *WSHandler) pushVoiceToMembers(
	ctx context.Context,
	channelID uuid.UUID,
	kind string,
	payload any,
) {
	members, err := h.store.ListMembersForChannel(ctx, channelID)
	if err != nil {
		h.logger.Printf("voice push: list members %s: %v", channelID, err)
		return
	}
	for _, m := range members {
		if perr := h.publishVoiceEvent(ctx, m, channelID, kind, payload); perr != nil {
			h.logger.Printf("publish voice %s to %s: %v", kind, m, perr)
		}
	}
}

// ---- disconnect cleanup ----------------------------------------------------

// voiceDisconnect removes every voice_participants row bound to this conn
// (WS teardown path; deferred next to hub.Unregister) and fans "left" per
// vacated room. Uses a fresh short context: the conn's own ctx is already
// canceled by the time the defer runs.
func (h *WSHandler) voiceDisconnect(conn *Conn) {
	if h.store == nil || !h.cfg.Voice.Enabled {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	gone, err := h.store.DeleteVoiceParticipantsByConn(ctx,
		voiceConnID(h.instanceID, conn.ID))
	if err != nil {
		h.logger.Printf("voice disconnect cleanup: %v", err)
		return
	}
	for _, p := range gone {
		h.pushVoiceToMembers(ctx, p.ChannelID, "left", proto.VoiceParticipantLeftPayload{
			ChannelID: p.ChannelID.String(),
			UserID:    p.UserID.String(),
			DeviceID:  p.DeviceID.String(),
		})
	}
}

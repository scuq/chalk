package proto

// Voice signaling frames (Phase 30, slice 30-2; design §4). Signaling rides
// the existing authenticated WS as new frame types. The voice_signal payload
// blob is E2E-ENCRYPTED SDP/ICE under the channel space key: the server
// routes it by (to_user, to_device) and NEVER inspects or logs it.

import "encoding/json"

// ---- frame types -----------------------------------------------------------

const (
	// Client -> server.
	TypeVoiceJoin   = "voice_join"
	TypeVoiceLeave  = "voice_leave"
	TypeVoiceRoster = "voice_roster"
	TypeVoiceSignal = "voice_signal"
	TypeVoiceState  = "voice_state"

	// Server -> client (acks to a ref).
	TypeVoiceJoinAck   = "voice_join_ack"
	TypeVoiceLeaveAck  = "voice_leave_ack"
	TypeVoiceRosterAck = "voice_roster_ack"
	TypeVoiceStateAck  = "voice_state_ack"

	// Server -> client (pushes, no ref).
	TypeVoiceParticipantJoined = "voice_participant_joined"
	TypeVoiceParticipantLeft   = "voice_participant_left"
	TypeVoiceParticipantState  = "voice_participant_state"
	// TypeVoiceSignal doubles as the push type for a relayed signal
	// (server->client voice_signal carries VoiceSignalPushPayload).
)

// ---- error codes -----------------------------------------------------------

const (
	ErrCodeVoiceDisabled       = "voice_disabled"        // CHALK_VOICE_ENABLED=false
	ErrCodeVoiceRoomFull       = "voice_room_full"       // mesh cap reached
	ErrCodeNotVoiceChannel     = "not_voice_channel"     // channel_type != 'voice'
	ErrCodeVoiceDeviceConflict = "voice_device_conflict" // same user, other device in room
	ErrCodeVoiceNotInRoom      = "voice_not_in_room"     // sender/target not a participant
)

// ---- shared shapes ---------------------------------------------------------

// VoiceParticipantView is one roster entry: a (user, device) currently in the
// room plus its broadcast media flags.
type VoiceParticipantView struct {
	UserID   string `json:"user_id"`
	DeviceID string `json:"device_id"`
	Muted    bool   `json:"muted"`
	VideoOn  bool   `json:"video_on"`
	ScreenOn bool   `json:"screen_on"`
}

// ICEServer mirrors the WebRTC RTCIceServer dictionary as handed to a joining
// client. Username/Credential are empty for STUN entries; for TURN they carry
// the short-lived HMAC credential minted by internal/turncred (design §5).
type ICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

// ---- client -> server ------------------------------------------------------

// VoiceJoinPayload asks to enter channelID's live room. The caller must be a
// channel member; the channel must be channel_type='voice'.
type VoiceJoinPayload struct {
	ChannelID string `json:"channel_id"`
}

// VoiceLeavePayload leaves the room. Idempotent (leaving twice is fine).
type VoiceLeavePayload struct {
	ChannelID string `json:"channel_id"`
}

// VoiceRosterPayload asks for the current occupants (members-only).
type VoiceRosterPayload struct {
	ChannelID string `json:"channel_id"`
}

// VoiceSignalPayload relays one E2E-encrypted signaling blob (offer / answer /
// ICE candidate / screen add-remove control) to ONE (user, device) in the same
// room. Kind is a routing discriminator only; Payload is opaque ciphertext the
// server forwards untouched (and never logs).
type VoiceSignalPayload struct {
	ChannelID string          `json:"channel_id"`
	ToUser    string          `json:"to_user"`
	ToDevice  string          `json:"to_device"`
	Kind      string          `json:"kind"` // offer|answer|ice|screen_add|screen_remove
	Payload   json.RawMessage `json:"payload"`
}

// VoiceStatePayload broadcasts the sender's media flags (self-mute / camera /
// screen) so rosters render them. Distinct from per-viewer LOCAL controls
// (design Addendum A1), which never touch the server.
type VoiceStatePayload struct {
	ChannelID string `json:"channel_id"`
	Muted     bool   `json:"muted"`
	VideoOn   bool   `json:"video_on"`
	ScreenOn  bool   `json:"screen_on"`
}

// ---- server -> client (acks) ----------------------------------------------

// VoiceJoinAckPayload confirms a join: the roster BEFORE fan-out races (the
// joiner offers to exactly these existing peers -- glare-free handshake,
// design §4), the ICE servers (TURN creds minted per-join, design §5), and
// whether the client must force relay-only ICE (CHALK_VOICE_FORCE_RELAY, the
// no-P2P acceptance gate §7d).
type VoiceJoinAckPayload struct {
	ChannelID  string                 `json:"channel_id"`
	Roster     []VoiceParticipantView `json:"roster"`
	ICEServers []ICEServer            `json:"ice_servers"`
	ForceRelay bool                   `json:"force_relay,omitempty"`
}

// VoiceLeaveAckPayload confirms a leave. Left is false when the caller was
// not in the room (idempotent leave).
type VoiceLeaveAckPayload struct {
	ChannelID string `json:"channel_id"`
	Left      bool   `json:"left"`
}

// VoiceRosterAckPayload returns the current occupants.
type VoiceRosterAckPayload struct {
	ChannelID string                 `json:"channel_id"`
	Roster    []VoiceParticipantView `json:"roster"`
}

// VoiceStateAckPayload confirms a state broadcast was recorded.
type VoiceStateAckPayload struct {
	ChannelID string `json:"channel_id"`
}

// ---- server -> client (pushes) ---------------------------------------------

// VoiceParticipantJoinedPayload / ...LeftPayload announce roster deltas to all
// channel members (in-room or not, so the sidebar occupancy stays live).
type VoiceParticipantJoinedPayload struct {
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
	DeviceID  string `json:"device_id"`
}

type VoiceParticipantLeftPayload struct {
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
	DeviceID  string `json:"device_id"`
}

// VoiceParticipantStatePayload announces a media-flag change.
type VoiceParticipantStatePayload struct {
	ChannelID string `json:"channel_id"`
	UserID    string `json:"user_id"`
	DeviceID  string `json:"device_id"`
	Muted     bool   `json:"muted"`
	VideoOn   bool   `json:"video_on"`
	ScreenOn  bool   `json:"screen_on"`
}

// VoiceSignalPushPayload is the relayed form of a voice_signal delivered to
// the target device. Payload is the same opaque ciphertext the sender posted.
type VoiceSignalPushPayload struct {
	ChannelID  string          `json:"channel_id"`
	FromUser   string          `json:"from_user"`
	FromDevice string          `json:"from_device"`
	Kind       string          `json:"kind"`
	Payload    json.RawMessage `json:"payload"`
}

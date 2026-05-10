package proto

// Payload types for chalk wire frames. Phase 04 introduced Hello,
// Welcome, Send, Message, Error. Phase 06 extends HelloPayload with
// an optional DeviceType field for presence-heartbeat cadence.
//
// All payload types are JSON-encoded as the `payload` field of the
// outer Frame envelope.
//
// This file is a replacement for the phase-04 payload-types file. If
// your existing tree names this file differently (e.g. payloads.go),
// rename to match or apply the one-line addition manually instead.

// HelloPayload is the first frame from a client. device_id is required
// and must be a UUID string. device_type is optional; if omitted or
// unrecognized, the server treats the device as "browser-unknown"
// (the safest, longest heartbeat TTL).
//
// Phase 11 will tie device_id to an authenticated session; phase 06's
// client-supplied device_id is provisional.
type HelloPayload struct {
	DeviceID   string `json:"device_id"`
	DeviceType string `json:"device_type,omitempty"`
}

// WelcomePayload is the server's response to Hello. Channels is the
// list of channels the user is currently a member of; phase 06 leaves
// this empty (real channels arrive in phase 08).
type WelcomePayload struct {
	UserID   string   `json:"user_id"`
	DeviceID string   `json:"device_id"`
	Channels []string `json:"channels"`
}

// SendPayload is the client's request to send a message. Phase 06's
// body field carries plaintext; phase 10 will replace this with
// MLS-encrypted ciphertext.
type SendPayload struct {
	ChannelID string `json:"channel_id,omitempty"`
	Body      string `json:"body"`
}

// MessagePayload is the server's push of a delivered message. Sender
// may be empty if the sending device's user has been purged (phase 12),
// in which case clients render "[unknown sender]".
type MessagePayload struct {
	ID     string `json:"id"`
	Sender string `json:"sender"`
	TS     int64  `json:"ts"`
	Body   string `json:"body"`
}

// ErrorPayload reports a per-frame error. Ref echoes the originating
// frame's ref so clients can correlate requests with errors.
type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Package proto defines chalk's WebSocket wire protocol.
//
// Every frame is a JSON object with a "type" discriminator and an optional
// "ref" correlation ID. Server-initiated frames have no ref; client requests
// that expect a paired response set ref to a value the server echoes back.
//
// The Frame envelope is intentionally small: type, ref, and a Payload that
// holds the type-specific fields. This lets us route on Type without parsing
// the whole payload, and keeps the type-switch in the server narrow.
//
// Frame size is capped at MaxFrameBytes to bound per-connection memory. The
// WebSocket library enforces this on read; values larger than MaxFrameBytes
// abort the connection with a protocol violation.
package proto

import (
	"encoding/json"
	"errors"
	"fmt"
)

// Subprotocol is the WebSocket subprotocol token. The server registers it
// in the Upgrade handshake; clients that don't request it are rejected.
// When we ship v2, we'll add "chalk.v2" alongside this and negotiate.
const Subprotocol = "chalk.v1"

// MaxFrameBytes caps a single WebSocket frame's payload (across both
// directions). 1 MiB is plenty for application messages and MLS commits;
// attachments go through a separate HTTP upload, never WebSocket.
const MaxFrameBytes = 1 << 20 // 1 MiB

// ---- Frame envelope ------------------------------------------------------

// Frame is the outermost JSON object on every WebSocket message.
type Frame struct {
	Type    string          `json:"type"`
	Ref     string          `json:"ref,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

// NewFrame builds a Frame with the given type and a payload that's encoded
// to JSON. Returns an error only if encoding fails (i.e. payload contains
// an unencodable value), which is a programmer bug, not a runtime concern.
func NewFrame(typ, ref string, payload any) (Frame, error) {
	if typ == "" {
		return Frame{}, errors.New("proto: frame type required")
	}
	f := Frame{Type: typ, Ref: ref}
	if payload != nil {
		raw, err := json.Marshal(payload)
		if err != nil {
			return Frame{}, fmt.Errorf("proto: marshal payload: %w", err)
		}
		f.Payload = raw
	}
	return f, nil
}

// DecodePayload unmarshals the frame's payload into dst. dst must be a
// non-nil pointer to a struct.
func (f Frame) DecodePayload(dst any) error {
	if len(f.Payload) == 0 {
		return errors.New("proto: empty payload")
	}
	if err := json.Unmarshal(f.Payload, dst); err != nil {
		return fmt.Errorf("proto: decode %s payload: %w", f.Type, err)
	}
	return nil
}

// ---- Frame types (phase 04 subset) ---------------------------------------
//
// The full set is documented in docs/wire-protocol.md. Phase 04 implements
// only what's needed for plaintext echo:
//
//   client → server:  hello, send, ping
//   server → client:  welcome, message, error, pong
//
// Later phases add: publish_keypkgs, create_channel, fetch_history, etc.
// Phase 06 adds presence_* and friend_* (see frames_phase06.go).

const (
	// Client → server.
	TypeHello = "hello"
	TypeSend  = "send"

	// Server → client.
	TypeWelcome = "welcome"
	TypeMessage = "message"
	TypeError   = "error"
)

// HelloPayload is sent by the client immediately after connect.
// In phase 04 the server trusts the device_id; phase 11 ties it to a
// passkey-authenticated session.
//
// DeviceType is optional; phase 06 added it to inform per-device-type
// presence heartbeat cadence. Recognized values: "phone", "tablet",
// "desktop". Missing or unrecognized values default server-side to
// "browser-unknown" (the longest, safest TTL).
type HelloPayload struct {
	DeviceID   string `json:"device_id"`
	DeviceType string `json:"device_type,omitempty"`
}

// WelcomePayload is the server's reply to Hello. Channels list is empty
// in phase 04 (channels arrive in phase 08).
type WelcomePayload struct {
	UserID   string   `json:"user_id"`
	DeviceID string   `json:"device_id"`
	Channels []string `json:"channels"`
}

// SendPayload is a plaintext message in phase 04. From phase 10 onwards the
// Body is replaced by an MLS-encrypted ciphertext, but the envelope shape
// stays the same.
type SendPayload struct {
	// Body is the message text in phase 04. Replaced by Ciphertext in phase 10.
	Body string `json:"body"`
}

// MessagePayload is what the server pushes to peers. id and ts are
// server-assigned; sender is the device_id from the originating Hello.
type MessagePayload struct {
	ID     string `json:"id"`
	Sender string `json:"sender"` // sender device_id
	TS     int64  `json:"ts"`     // server unix-millis
	Body   string `json:"body"`
}

// ErrorPayload is sent when the server can't process a request. Code is a
// short token clients can match on; Message is human-readable.
type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Common error codes. Keep stable across versions.
const (
	ErrCodeBadFrame      = "bad_frame"
	ErrCodeBadPayload    = "bad_payload"
	ErrCodeUnknownType   = "unknown_type"
	ErrCodeNotHelloed    = "not_helloed"
	ErrCodeInternal      = "internal"
	ErrCodeRateLimited   = "rate_limited"
	ErrCodeFrameTooLarge = "frame_too_large"
)

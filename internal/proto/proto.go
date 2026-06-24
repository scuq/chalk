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
	"time"
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

// ---- Frame types ---------------------------------------------------------
//
// The full set is documented in docs/wire-protocol.md. Phase 04 implemented
// the bare minimum:
//
//   client → server:  hello, send, ping
//   server → client:  welcome, message, error, pong
//
// Phase 06 added presence_* and friend_* (see frames_phase06.go).
// Phase 08 adds create_channel, list_channels, fetch_history,
// channel_event (see frames_phase08.go).

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

// WelcomePayload is the server's reply to Hello. Channels list is
// populated in phase 08 with the channel IDs the user is a member of.
// Phase 04-07 always returned an empty list.
//
// Phase 09b sub-step 5 extends the welcome to carry the session-
// resolved user identity: username (the immutable login key),
// display_name (mutable, free-form), role ('user' | 'admin'),
// session_expires_at (so the SPA can show a "session expiring"
// notice), and email_verified (boolean derived from
// users.email_verified_at non-null). The pre-09b "handle" field
// stays for transitional wire compatibility -- the SPA may consult
// either handle or username depending on which sub-phase its build
// targeted. New SPA code should prefer username.
type WelcomePayload struct {
	UserID   string   `json:"user_id"`
	DeviceID string   `json:"device_id"`
	Handle   string   `json:"handle"` // phase 08c (preserved for transition)
	Channels []string `json:"channels"`
	// Phase 09b sub-step 5 additions:
	Username         string    `json:"username,omitempty"`
	DisplayName      string    `json:"display_name,omitempty"`
	Role             string    `json:"role,omitempty"`
	SessionExpiresAt time.Time `json:"session_expires_at,omitempty"`
	EmailVerified    bool      `json:"email_verified,omitempty"`
}

// SendPayload is a plaintext message in phase 04. From phase 10 onwards the
// Body carries the message text. (Pre-21-7 this was an MLS ciphertext.)
// stays the same.
//
// Phase 08: ChannelID names the destination channel. Omitted/empty values
// fall back server-side to the placeholder default channel for
// compatibility with pre-phase-08 SPAs during transition. The phase 08+
// SPA always sets ChannelID explicitly.
type SendPayload struct {
	ChannelID string `json:"channel_id,omitempty"`
	// Body is the message text.
	Body string `json:"body"`
	// Phase 10a: optional parent message ID. When set, this send is a
	// thread reply. The server resolves thread_id from the parent
	// (parent.thread_id if non-nil, else parent.id) and validates that
	// the parent exists in the same channel.
	ParentID string `json:"parent_id,omitempty"`
	// Phase 23d: message-suite key version. nil/0 = legacy plaintext
	// body; >=1 = the body is suite-tagged ciphertext under the
	// channel space key of that version. The server stores + echoes
	// it but never inspects the (opaque) body.
	KeyVersion *int `json:"key_version,omitempty"`
	// att-1: ids of attachments to link to this message. The server
	// validates each (complete, same channel, unlinked, owned by the
	// sender) inside the send tx; a mismatch rolls the whole send back.
	// De-duplicated and capped (CHALK_ATTACH_MAX_PER_MESSAGE) server-side.
	AttachmentIDs []string `json:"attachment_ids,omitempty"`
}

// MessagePayload is what the server pushes to peers. id and ts are
// server-assigned; sender is the device_id from the originating Hello.
//
// Phase 08: ChannelID and Seq are populated so clients can route the
// incoming message to the correct channel pane and maintain per-channel
// ordering. Seq is the channel-monotonic sequence assigned at insert.
type MessagePayload struct {
	ID        string `json:"id"`
	ChannelID string `json:"channel_id"`
	Seq       int64  `json:"seq"`
	Sender    string `json:"sender"` // sender device_id, or "" for purged-user msgs
	// Phase 9.6i: sender_user_id lets clients render the message
	// author's username instead of a device-id suffix. Empty when
	// the sender's user account has been purged or the device row
	// has been deleted. Old clients ignore this field; new clients
	// fall back to Sender (device_id) when this is empty.
	SenderUserID string `json:"sender_user_id,omitempty"`
	TS           int64  `json:"ts"` // server unix-millis
	Body         string `json:"body"`
	// Phase 10a: threading metadata. ParentID set when this message
	// is a thread reply. ThreadID set whenever the message is part of
	// a thread (either the head OR a reply); empty for standalone
	// messages. ReplyCount is the number of replies WHERE thread_id =
	// this.id (only meaningful for messages that are thread heads);
	// 0 otherwise.
	ParentID   string `json:"parent_id,omitempty"`
	ThreadID   string `json:"thread_id,omitempty"`
	ReplyCount int64  `json:"reply_count,omitempty"`
	// Phase 23d: see SendPayload.KeyVersion. nil = legacy plaintext.
	KeyVersion *int `json:"key_version,omitempty"`
	// Phase 10d: highest seq among replies in this thread. Used by
	// clients to compute "unread" badges when compared against a
	// locally-stored "last seen" seq per thread.
	LastReplySeq int64 `json:"last_reply_seq,omitempty"`
	// Phase 10e: preview of the most recent reply, used to render
	// a one-line snippet beneath the indicator. Both empty when the
	// message isn't a thread head (or its last reply's sender has
	// been purged).
	LastReplySenderUserID string `json:"last_reply_sender_user_id,omitempty"`
	LastReplyBody         string `json:"last_reply_body,omitempty"`
	LastReplyKeyVersion   *int   `json:"last_reply_key_version,omitempty"`
	// Phase 26 (governance prereq): soft-delete tombstone. When Deleted is
	// true the message has been deleted; Body is empty and KeyVersion is nil,
	// so clients render a "message deleted" placeholder and skip decryption.
	// DeletedBy is the user_id that deleted it (audit / future "deleted by X"
	// rendering); DeletedAt is server unix-millis of the deletion. All omitted
	// for live messages so older clients simply ignore them.
	Deleted   bool   `json:"deleted,omitempty"`
	DeletedBy string `json:"deleted_by,omitempty"`
	DeletedAt int64  `json:"deleted_at,omitempty"`
	// att-1: attachments linked to this message, populated on the live
	// push. Empty for the common attachment-less message and for history
	// fetches (those backfill via GET /api/attachments). See AttachmentRef.
	Attachments []AttachmentRef `json:"attachments,omitempty"`
}

// ErrorPayload is sent when the server can't process a request. Code is a
// short token clients can match on; Message is human-readable.
type ErrorPayload struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// Common error codes. Keep stable across versions.
const (
	ErrCodeBadFrame           = "bad_frame"
	ErrCodeInvalidParent      = "invalid_parent" // Phase 10a
	ErrCodeBadPayload         = "bad_payload"
	ErrCodeEncryptionRequired = "encryption_required" // Phase 23f (fail-closed)
	ErrCodeUnknownType        = "unknown_type"
	ErrCodeNotHelloed         = "not_helloed"
	ErrCodeInternal           = "internal"
	ErrCodeRateLimited        = "rate_limited"
	ErrCodeFrameTooLarge      = "frame_too_large"
	// Phase 26 (governance prereq: message deletion):
	ErrCodeMessageNotFound = "message_not_found"
	ErrCodeDeleteForbidden = "delete_forbidden"
)

// Phase 10a: fetch a thread's messages by thread_id. Like
// fetch_history but scoped to one thread. Ordering: newest-first by
// seq DESC; client reverses to render oldest-first if it wants.
const (
	TypeFetchThread    = "fetch_thread"
	TypeFetchThreadAck = "fetch_thread_ack"
)

type FetchThreadPayload struct {
	ChannelID string `json:"channel_id"`
	ThreadID  string `json:"thread_id"`
	BeforeSeq int64  `json:"before_seq,omitempty"` // 0 means newest
	Limit     int    `json:"limit,omitempty"`      // default 50, max 200
}

type FetchThreadAckPayload struct {
	ChannelID string           `json:"channel_id"`
	ThreadID  string           `json:"thread_id"`
	Messages  []MessagePayload `json:"messages"`
}

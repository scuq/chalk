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
	UserID           string    `json:"user_id"`
	DeviceID         string    `json:"device_id"`
	Handle           string    `json:"handle"`   // phase 08c (preserved for transition)
	Channels         []string  `json:"channels"`
	// Phase 09b sub-step 5 additions:
	Username         string    `json:"username,omitempty"`
	DisplayName      string    `json:"display_name,omitempty"`
	Role             string    `json:"role,omitempty"`
	SessionExpiresAt time.Time `json:"session_expires_at,omitempty"`
	EmailVerified    bool      `json:"email_verified,omitempty"`
}

// SendPayload is a plaintext message in phase 04. From phase 10 onwards the
// Body is replaced by an MLS-encrypted ciphertext, but the envelope shape
// stays the same.
//
// Phase 08: ChannelID names the destination channel. Omitted/empty values
// fall back server-side to the placeholder default channel for
// compatibility with pre-phase-08 SPAs during transition. The phase 08+
// SPA always sets ChannelID explicitly.
type SendPayload struct {
	ChannelID string `json:"channel_id,omitempty"`
	// Body is the message text in phase 04. Replaced by Ciphertext in phase 10.
	Body string `json:"body"`
	// Phase 10a: optional parent message ID. When set, this send is a
	// thread reply. The server resolves thread_id from the parent
	// (parent.thread_id if non-nil, else parent.id) and validates that
	// the parent exists in the same channel.
	ParentID string `json:"parent_id,omitempty"`
	// Phase 11b-1: content_type tells the server how to interpret Body.
	// Omitted/empty -> "application" (legacy plaintext).
	//                  Body is treated as UTF-8 text, stored as bytes.
	// "mls_ciphertext" -> Body is base64-encoded ciphertext bytes.
	//                     Server decodes b64, stores raw bytes, never
	//                     attempts to interpret them.
	ContentType string `json:"content_type,omitempty"`
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
	ParentID     string `json:"parent_id,omitempty"`
	ThreadID     string `json:"thread_id,omitempty"`
	ReplyCount   int64  `json:"reply_count,omitempty"`
	// Phase 10d: highest seq among replies in this thread. Used by
	// clients to compute "unread" badges when compared against a
	// locally-stored "last seen" seq per thread.
	LastReplySeq int64  `json:"last_reply_seq,omitempty"`
	// Phase 10e: preview of the most recent reply, used to render
	// a one-line snippet beneath the indicator. Both empty when the
	// message isn't a thread head (or its last reply's sender has
	// been purged).
	LastReplySenderUserID string `json:"last_reply_sender_user_id,omitempty"`
	LastReplyBody         string `json:"last_reply_body,omitempty"`
	// Phase 11b-1: content_type so the client can detect encrypted rows.
	// "application" (or empty) = plaintext; "mls_ciphertext" = MLS bytes.
	ContentType string `json:"content_type,omitempty"`

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
	ErrCodeInvalidParent = "invalid_parent" // Phase 10a
	ErrCodeBadPayload    = "bad_payload"
	ErrCodeUnknownType   = "unknown_type"
	ErrCodeNotHelloed    = "not_helloed"
	ErrCodeInternal      = "internal"
	ErrCodeRateLimited   = "rate_limited"
	ErrCodeFrameTooLarge = "frame_too_large"
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

// ---- Phase 11a: MLS KeyPackage publish/fetch ------------------------

const (
	// publish_key_packages: client uploads a batch of KeyPackages
	// for its current device. Server validates that each KP's
	// client_id field is "<userID>:<deviceID>" matching the WS
	// connection.
	TypePublishKeyPackages    = "publish_key_packages"
	TypePublishKeyPackagesAck = "publish_key_packages_ack"

	// fetch_key_packages: client requests one fresh KP per listed
	// user. Server claims (marks used_at) one unused KP per user
	// and returns the byte blobs. If a user has zero unused KPs,
	// they are omitted from the response (caller learns who is
	// "not ready" for MLS).
	TypeFetchKeyPackages    = "fetch_key_packages"
	TypeFetchKeyPackagesAck = "fetch_key_packages_ack"

	// key_package_count: client asks "how many unused KPs do I have
	// on the server for my own device?" -- used to decide whether
	// to publish more.
	TypeKeyPackageCount    = "key_package_count"
	TypeKeyPackageCountAck = "key_package_count_ack"
)

// PublishKeyPackagesPayload uploads one or more KeyPackages for the
// publishing device. Ciphersuite + credential_type are repeated per
// KP because nothing prevents a device from publishing KPs for
// multiple suites in one frame, though chalk currently only uses one.
type PublishKeyPackagesPayload struct {
	KeyPackages []KeyPackageEntry `json:"key_packages"`
}

type KeyPackageEntry struct {
	Ciphersuite     int    `json:"ciphersuite"`     // MLS ciphersuite id
	CredentialType  int    `json:"credential_type"` // 1 = Basic
	ClientIDClaimed string `json:"client_id_claimed"`
	// KeyPackageData is base64-encoded TLS-serialized bytes.
	KeyPackageData  string `json:"key_package_data"`
}

type PublishKeyPackagesAckPayload struct {
	Accepted int `json:"accepted"` // how many were valid + stored
}

// FetchKeyPackagesPayload requests KPs for these users. The server
// claims one unused KP per user (marks used_at) and returns the
// blobs. Missing users get omitted, NOT errored -- caller decides
// what to do (typical: ask the user to come online so they can
// publish KPs).
type FetchKeyPackagesPayload struct {
	UserIDs     []string `json:"user_ids"`
	Ciphersuite int      `json:"ciphersuite,omitempty"` // default: 1
}

type FetchKeyPackagesAckPayload struct {
	KeyPackages []FetchedKeyPackage `json:"key_packages"`
}

type FetchedKeyPackage struct {
	UserID         string `json:"user_id"`
	DeviceID       string `json:"device_id"`
	ClientID       string `json:"client_id"` // <user_id>:<device_id>
	Ciphersuite    int    `json:"ciphersuite"`
	CredentialType int    `json:"credential_type"`
	KeyPackageData string `json:"key_package_data"` // base64
}

// KeyPackageCountPayload is empty -- the WS connection identifies
// the device; no parameters needed.
type KeyPackageCountPayload struct{}

type KeyPackageCountAckPayload struct {
	Count int `json:"count"`
}

// Phase 11a errors.
const (
	ErrCodeKPClientIDMismatch = "kp_client_id_mismatch"
	ErrCodeKPMalformed        = "kp_malformed"
)

// ---- Phase 11b-1: MLS commit/welcome wire ---------------------------

const (
	// mls_commit_bundle: client uploads a Commit + Welcome bundle
	// after creating or modifying an MLS group. Server upserts the
	// mls_groups row and fans each Welcome to its addressee's
	// connected devices. For 11b-1, offline addressees lose the
	// welcome silently; later phases can buffer.
	TypeMlsCommitBundle    = "mls_commit_bundle"
	TypeMlsCommitBundleAck = "mls_commit_bundle_ack"

	// mls_welcome: server -> client push delivering a welcome to a
	// newly-added member. Includes the channel_id so the client can
	// associate the group with a channel, and the sender so the
	// recipient knows who added them.
	TypeMlsWelcome    = "mls_welcome"
	TypeMlsWelcomeAck = "mls_welcome_ack"
)

// Content-type vocabulary the server understands. Stored in
// messages.content_type and surfaced to clients via MessagePayload.
const (
	ContentTypeApplication   = "application"     // plaintext (legacy default)
	ContentTypeMlsCiphertext = "mls_ciphertext"  // MLS-encrypted bytes
)

// WelcomeFor is one (recipient, welcome bytes) pair in an
// mls_commit_bundle. The recipient is identified by user_id; the
// server pushes to all of that user's connected devices.
type WelcomeFor struct {
	UserID  string `json:"user_id"`
	// Welcome is base64-encoded TLS-serialized Welcome bytes.
	Welcome string `json:"welcome"`
}

type MlsCommitBundlePayload struct {
	ChannelID  string       `json:"channel_id"`
	// MlsGroupID is base64-encoded opaque bytes from CoreCrypto.
	MlsGroupID string       `json:"mls_group_id"`
	// Commit is base64-encoded TLS-serialized Commit bytes. Optional
	// for now (a group-creation bundle has no commit_to_others, just
	// Welcomes for the initial members); future epoch bumps will set
	// it.
	Commit     string       `json:"commit,omitempty"`
	WelcomeFor []WelcomeFor `json:"welcome_for,omitempty"`
	Epoch      int64        `json:"epoch"`

	// Phase 11c-1 PR 3: declared membership changes accompanying this
	// commit. Each entry must match an authorization issued by
	// add_to_channel / remove_from_channel within the last 60s. An
	// empty list means "no membership change in this commit" (e.g.
	// key-rotation Updates, Welcome-only bundles).
	ProposedAdds    []string     `json:"proposed_adds,omitempty"`
	ProposedRemoves []string     `json:"proposed_removes,omitempty"`
}

type MlsCommitBundleAckPayload struct {
	ChannelID string `json:"channel_id"`
	// Delivered is how many welcomes were fan'd to at least one
	// connected device of the recipient. Welcomes for offline users
	// count as 0.
	Delivered int    `json:"delivered"`
}

type MlsWelcomePayload struct {
	ChannelID     string `json:"channel_id"`
	MlsGroupID    string `json:"mls_group_id"`
	Welcome       string `json:"welcome"`
	SenderUserID  string `json:"sender_user_id"`
}

type MlsWelcomeAckPayload struct {
	ChannelID string `json:"channel_id"`
	OK        bool   `json:"ok"`
}

// Phase 11b-1 errors.
const (
	ErrCodeMlsBadBundle   = "mls_bad_bundle"
	ErrCodeMlsNotMember   = "mls_not_member"
)

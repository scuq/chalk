package proto

// Wire frame type definitions for the chalk protocol.
// Consolidated from the former phase-numbered frames_phase*.go files.

// ===== merged from frames_phase06.go =====

// Phase 06 wire frame types.
//
// These add presence and friendship operations to the chalk wire protocol.
// All frames are JSON-encoded over the WebSocket using the existing
// proto.Frame envelope (type + ref + payload). Payload shapes are defined
// here.

// --- presence: server-to-client push -----------------------------------

const (
	// TypePresence is a server-initiated push notifying a subscribed
	// client that a target user's presence changed.
	TypePresence = "presence"

	// TypePresenceSubscribe is a client request to start receiving
	// presence updates for a list of users. The server returns
	// presence_subscribe_ack with two lists: subscribed (the user_ids
	// that are valid mutual friends and now being tracked) and rejected
	// (the user_ids that were refused, each with a reason). The mutual-
	// friendship check happens server-side; non-friends are rejected by
	// explicit reason per the phase-06 design.
	TypePresenceSubscribe    = "presence_subscribe"
	TypePresenceSubscribeAck = "presence_subscribe_ack"

	TypePresenceUnsubscribe    = "presence_unsubscribe"
	TypePresenceUnsubscribeAck = "presence_unsubscribe_ack"

	// TypePresenceUpdate is client-to-server: "my state is now X."
	// Server records and re-emits to subscribers. Server-side sanity
	// checks may demote the state if heartbeats fall behind.
	TypePresenceUpdate    = "presence_update"
	TypePresenceUpdateAck = "presence_update_ack"
)

// PresencePayload is the server push body. State is one of
// "online", "away", "offline". Carries the aggregated state across the
// target user's devices, not any single device's state.
type PresencePayload struct {
	UserID string `json:"user_id"`
	State  string `json:"state"`
	// At is the wall-clock timestamp (ms since epoch) of the most recent
	// observed activity for this user across any of their devices.
	At int64 `json:"at"`
}

// PresenceSubscribePayload is the client request.
type PresenceSubscribePayload struct {
	UserIDs []string `json:"user_ids"`
}

// PresenceRejection explains why a particular user_id was refused. Codes:
//
//	not_found       -- user doesn't exist or is soft_blocked/deleted
//	not_a_friend    -- exists, but no accepted friendship with the caller
//	self            -- can't subscribe to your own presence
type PresenceRejection struct {
	UserID string `json:"user_id"`
	Reason string `json:"reason"`
}

// PresenceSubscribeAckPayload returns both successful and rejected
// subscriptions. The successful list is what the client should treat as
// "active subscriptions"; rejected entries carry a per-id reason.
type PresenceSubscribeAckPayload struct {
	Subscribed []string            `json:"subscribed"`
	Rejected   []PresenceRejection `json:"rejected"`
}

// PresenceUnsubscribePayload is symmetric with subscribe; no rejections
// possible, since unsubscribing from a non-subscription is a no-op.
type PresenceUnsubscribePayload struct {
	UserIDs []string `json:"user_ids"`
}

// PresenceUnsubscribeAckPayload echoes back which user_ids are no longer
// subscribed (whether or not they were before).
type PresenceUnsubscribeAckPayload struct {
	Unsubscribed []string `json:"unsubscribed"`
}

// PresenceUpdatePayload is the client's claim about its own state.
type PresenceUpdatePayload struct {
	State string `json:"state"`
}

type PresenceUpdateAckPayload struct {
	State string `json:"state"`
}

// --- friendship operations ---------------------------------------------

const (
	TypeFriendRequest    = "friend_request"
	TypeFriendRequestAck = "friend_request_ack"

	TypeFriendAccept    = "friend_accept"
	TypeFriendAcceptAck = "friend_accept_ack"

	TypeFriendDecline    = "friend_decline"
	TypeFriendDeclineAck = "friend_decline_ack"

	TypeFriendRemove    = "friend_remove"
	TypeFriendRemoveAck = "friend_remove_ack"

	TypeFriendBlock    = "friend_block"
	TypeFriendBlockAck = "friend_block_ack"

	TypeFriendUnblock    = "friend_unblock"
	TypeFriendUnblockAck = "friend_unblock_ack"

	TypeFriendList    = "friend_list"
	TypeFriendListAck = "friend_list_ack"

	// TypeFriendEvent is server-to-client push: an asynchronous friendship
	// state change. Fired when a friend request is received, accepted,
	// declined, or when an existing friendship is removed by the other
	// side. Block events are NOT fired; the blocker shouldn't be revealed.
	TypeFriendEvent = "friend_event"
)

// FriendRequestPayload addresses a specific user by ID. The server checks
// the target's status (must be active) and existing friendship state
// before recording the request.
type FriendRequestPayload struct {
	ToUserID string `json:"to_user_id"`
}

// FriendRequestAckPayload returns either status=requested (a new pending
// row was created) or status=auto_accepted (the target had already sent a
// pending request to you, so the friendship is now mutual). Errors return
// as ErrorPayload via the existing error path.
type FriendRequestAckPayload struct {
	ToUserID string `json:"to_user_id"`
	Status   string `json:"status"`
}

type FriendAcceptPayload struct {
	FromUserID string `json:"from_user_id"`
}

type FriendAcceptAckPayload struct {
	FromUserID string `json:"from_user_id"`
}

type FriendDeclinePayload struct {
	FromUserID string `json:"from_user_id"`
}

type FriendDeclineAckPayload struct {
	FromUserID string `json:"from_user_id"`
}

type FriendRemovePayload struct {
	UserID string `json:"user_id"`
}

type FriendRemoveAckPayload struct {
	UserID string `json:"user_id"`
}

type FriendBlockPayload struct {
	UserID string `json:"user_id"`
}

type FriendBlockAckPayload struct {
	UserID string `json:"user_id"`
}

type FriendUnblockPayload struct {
	UserID string `json:"user_id"`
}

type FriendUnblockAckPayload struct {
	UserID string `json:"user_id"`
}

// FriendListPayload is intentionally empty; the request takes no args.
type FriendListPayload struct{}

// FriendSummary is one row in a friend list response. Status is the
// lifecycle status of the friend's user account, NOT the friendship
// status; the friendship is implicitly "accepted" for entries in the
// accepted list, "pending" in the pending lists, "blocked" in the blocked
// list. Account-status surfaces "alice (inactive)" in the UI for friends
// whose accounts are soft_blocked or deleted.
type FriendSummary struct {
	UserID        string `json:"user_id"`
	Handle        string `json:"handle"`
	AccountStatus string `json:"account_status"`
}

// FriendListAckPayload returns four lists: outgoing pending requests
// (you requested), incoming pending requests (they requested you),
// accepted friendships, and people you've blocked.
type FriendListAckPayload struct {
	PendingOutgoing []FriendSummary `json:"pending_outgoing"`
	PendingIncoming []FriendSummary `json:"pending_incoming"`
	Accepted        []FriendSummary `json:"accepted"`
	Blocked         []FriendSummary `json:"blocked"`
}

// FriendEventPayload is server push for asynchronous friendship changes.
// Kind is one of:
//
//	request_received  -- someone sent you a friend request
//	accepted          -- someone accepted your request, or your request
//	                     auto-promoted an existing one
//	declined          -- someone declined your request
//	removed           -- someone removed you from their friends
type FriendEventPayload struct {
	Kind       string `json:"kind"`
	FromUserID string `json:"from_user_id"`
	Handle     string `json:"handle"`
}

// --- error codes added by phase 06 -------------------------------------

const (
	ErrCodeUserNotFound      = "user_not_found"
	ErrCodeUserUnavailable   = "user_unavailable" // soft_blocked or deleted
	ErrCodeNotFriends        = "not_friends"
	ErrCodeAlreadyFriends    = "already_friends"
	ErrCodeFriendshipBlocked = "friendship_blocked"
	ErrCodeCannotSelfFriend  = "cannot_self_friend"
	ErrCodeNoPendingRequest  = "no_pending_request"
	ErrCodeInvalidState      = "invalid_state"
)

// ===== merged from frames_phase08.go =====

// Phase 08 frame types: channel creation, listing, history fetch, and
// the server-pushed channel_event for when someone adds you to a new
// channel.
//
// Channel routing model (phase 08):
//   * One channel type (channels.is_dm differentiates UX, not access)
//   * Per-channel Postgres NOTIFY topic
//   * Membership-only visibility
//   * Create-time member list, all members must be friends of the creator
//
// All Ack frames echo back the ref of the originating request so clients
// can match request/response pairs without parsing payloads twice.

const (
	// Client → server.
	TypeCreateChannel = "create_channel"
	TypeListChannels  = "list_channels"
	TypeFetchHistory  = "fetch_history"

	// Server → client (ack to a request).
	TypeCreateChannelAck = "create_channel_ack"
	TypeListChannelsAck  = "list_channels_ack"
	TypeFetchHistoryAck  = "fetch_history_ack"

	// Server → client (push, no ref).
	TypeChannelEvent = "channel_event"
)

// ---- Channel summary -----------------------------------------------------

// ChannelSummary is the compact shape sent in list_channels_ack and
// channel_event. It deliberately omits the full member list -- clients
// fetch members on demand via a future phase if/when needed. Phase 08
// doesn't have a list_members frame; if you need to know who's in a
// channel beyond a DM's two participants, that's a phase 11+ concern.
type ChannelSummary struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	IsDM      bool            `json:"is_dm"`
	CreatedBy string          `json:"created_by"` // user_id; empty for system channels
	CreatedAt int64           `json:"created_at"` // unix-millis
	MemberIDs []string        `json:"member_ids"` // small; included in summary for DM-name rendering
	Members   []ChannelMember `json:"members"`    // phase 08c; pairs user_id with handle
	// CurrentKeyVersion is the channel's current space-key version (phase 25).
	// The client encrypts new messages under this version.
	CurrentKeyVersion int `json:"current_key_version"`
	// RotationPending is true when a removal hasn't been followed by a rotation
	// yet (the removed member still holds the old key until then).
	RotationPending bool `json:"rotation_pending"`
}

// ChannelMember pairs a user_id with their handle. Server
// returns these alongside MemberIDs so the SPA can render
// names instead of UUID prefixes. Phase 08c.
type ChannelMember struct {
	UserID string `json:"user_id"`
	Handle string `json:"handle"`
}

// ---- create_channel ------------------------------------------------------

// CreateChannelPayload requests creation of a new channel. The caller
// becomes the owner (role='owner'); each user_id in MemberIDs becomes a
// member (role='member'). The caller is implicitly added if not present
// in MemberIDs.
//
// Server rules:
//   - Name required, non-empty after trim, ≤80 chars.
//   - IsDM=true requires exactly one OTHER user (so the channel has
//     exactly 2 members total including the caller).
//   - All MemberIDs must be friends of the caller (per phase 06 friends).
//   - Non-friend / non-existent IDs cause the entire create to fail.
type CreateChannelPayload struct {
	Name      string   `json:"name"`
	IsDM      bool     `json:"is_dm,omitempty"`
	MemberIDs []string `json:"member_ids,omitempty"`
}

// CreateChannelAckPayload includes the full ChannelSummary so the client
// can add the new channel to its sidebar without a second roundtrip.
type CreateChannelAckPayload struct {
	Channel ChannelSummary `json:"channel"`
}

// ---- list_channels -------------------------------------------------------

// ListChannelsPayload takes no parameters in phase 08; the server returns
// all channels the caller is a member of. Pagination is deferred -- a
// typical user has tens, not thousands, of channels.
type ListChannelsPayload struct{}

// ListChannelsAckPayload returns the caller's channels in arbitrary order
// (the client sorts). Each summary carries enough info to render the
// sidebar entry.
type ListChannelsAckPayload struct {
	Channels []ChannelSummary `json:"channels"`
}

// ---- fetch_history -------------------------------------------------------

// FetchHistoryPayload requests historical messages for a channel.
//
//   - BeforeSeq: return messages with seq < BeforeSeq, in descending seq
//     order. Omit (zero value) to fetch from the newest message.
//   - Limit: cap on rows returned. Server enforces a hard ceiling of 200
//     regardless. Default applied server-side if zero is sent: 50.
//
// Pagination pattern: keep calling fetch_history with BeforeSeq = the
// smallest seq seen so far, until you receive fewer than Limit messages
// (which means you've hit the start of history).
type FetchHistoryPayload struct {
	ChannelID string `json:"channel_id"`
	BeforeSeq int64  `json:"before_seq,omitempty"`
	Limit     int    `json:"limit,omitempty"`
}

// FetchHistoryAckPayload returns up to Limit messages in descending seq
// order (newest first). An empty array means there's nothing older.
type FetchHistoryAckPayload struct {
	ChannelID string           `json:"channel_id"`
	BeforeSeq int64            `json:"before_seq"`
	Messages  []MessagePayload `json:"messages"`
}

// ---- channel_event -------------------------------------------------------

// ChannelEventPayload is pushed server→client when something happened to
// a channel the caller cares about. Kinds:
//
//   - "added":   the caller was added to a channel (created by someone
//     else). Channel summary attached.
//   - "removed": the caller was removed from a channel. Channel summary
//     may be partial (just the ID) since the caller no longer
//     has read access.
//
// Phase 08 only emits "added" (on create_channel). "removed" lands when
// we add remove_member, which is phase 11+.
type ChannelEventPayload struct {
	Kind    string         `json:"kind"`
	Channel ChannelSummary `json:"channel"`
}

// ---- Phase 08 error codes ------------------------------------------------

const (
	ErrCodeChannelNotFound = "channel_not_found"
	ErrCodeNotAMember      = "not_a_member"
	// Phase 25 (rotation):
	ErrCodeNotChannelCreator = "not_channel_creator"
	ErrCodeStaleKeyVersion   = "stale_key_version"
	// Member removal:
	ErrCodeCannotRemoveOwner = "cannot_remove_owner"
	ErrCodeDMNoRemoval       = "dm_no_removal"
	ErrCodeRemoveForbidden   = "remove_forbidden"
	// Member add:
	ErrCodeAlreadyMember  = "already_member"
	ErrCodeDMNoAdd        = "dm_no_add"
	ErrCodeInvalidChannel = "invalid_channel"
	ErrCodeDMCardinality  = "dm_cardinality"
)

// ===== merged from frames_phase08b.go =====

// Phase 08b adds subscribe_channel: a client-initiated frame that asks
// the server to LISTEN on the per-channel pubsub topic for an
// already-created channel. Needed because the listener's per-channel
// subscriptions are established at hello-time (snapshot of the user's
// channels) and don't pick up channels created mid-session.
//
// Usage flow:
//   1. Client receives channel_event{kind="added"} via chalk_global.
//   2. Client sends subscribe_channel{channel_id} on its WS.
//   3. Server verifies membership, calls listener.Subscribe(topic),
//      acks. After the ack, the client can safely send/receive in
//      the new channel without reconnecting.
//
// Why not auto-subscribe server-side when emitting channel_event:
//   The publishChannelEvent path emits on chalk_global, which lands on
//   the recipient's chalkd via the listener. By the time
//   handleChannelEvent runs, we'd need to find the recipient's *Conn
//   and call listener.Subscribe -- doable, but it adds coupling
//   between the listener's dispatch path and connection lifecycle.
//   Client-initiated keeps the boundary clean and matches the existing
//   pattern (clients ask for what they want).
//
// Disconnect cleanup: ws.go's per-conn subscribedTopics slice extends
// to include topics added by this handler. The defer-unsubscribe loop
// in ServeHTTP unsubscribes everything in that slice on close, so a
// dynamically-added subscription is correctly released.

const (
	// Client → server.
	TypeSubscribeChannel = "subscribe_channel"

	// Server → client.
	TypeSubscribeChannelAck = "subscribe_channel_ack"
)

// SubscribeChannelPayload identifies which channel to start listening
// on. The caller must be a member; the server returns ErrCodeNotAMember
// otherwise.
type SubscribeChannelPayload struct {
	ChannelID string `json:"channel_id"`
}

// SubscribeChannelAckPayload echoes the channel_id back. No additional
// fields; the ack is purely a "done, you can proceed" signal.
type SubscribeChannelAckPayload struct {
	ChannelID string `json:"channel_id"`
}

// ===== merged from frames_phase09g.go =====

// Phase 9.7 -- user preferences wire types.
//
// prefs_get      (client → server)     no body
// prefs_get_ack  (server → client)     { prefs: <obj> }
// prefs_set      (client → server)     { patch: <obj> }
// prefs_set_ack  (server → client)     { prefs: <merged obj> }
// prefs_changed  (server → client)     { prefs: <merged obj> }    [push]
//
// The prefs body is intentionally an opaque object. The server stores
// it as JSONB and enforces only a size cap. Typed fields are the
// SPA's concern -- the server doesn't validate individual keys, so
// adding a new pref is a SPA-only change.

const (
	TypePrefsGet     = "prefs_get"
	TypePrefsGetAck  = "prefs_get_ack"
	TypePrefsSet     = "prefs_set"
	TypePrefsSetAck  = "prefs_set_ack"
	TypePrefsChanged = "prefs_changed" // push
)

// ---- phase 22: identity keys -------------------------------------------
//
// A client publishes its per-user public identity (X25519 + Ed25519 +
// a self-signature) once it has derived the keypair from the 24-word
// phrase, and fetches other users' identities to wrap space keys / verify
// signatures. The server relays; clients verify the self-signature.
const (
	TypePublishIdentity    = "publish_identity"
	TypePublishIdentityAck = "publish_identity_ack"

	TypeFetchIdentity    = "fetch_identity"
	TypeFetchIdentityAck = "fetch_identity_ack"

	TypePublishChannelKey    = "publish_channel_key"
	TypePublishChannelKeyAck = "publish_channel_key_ack"

	TypeFetchChannelKey    = "fetch_channel_key"
	TypeFetchChannelKeyAck = "fetch_channel_key_ack"

	TypeRotateChannelKey    = "rotate_channel_key"
	TypeRotateChannelKeyAck = "rotate_channel_key_ack"

	TypeRemoveMember    = "remove_member"
	TypeRemoveMemberAck = "remove_member_ack"

	TypeAddMember    = "add_member"
	TypeAddMemberAck = "add_member_ack"

	TypeFetchChannelKeyRecipients    = "fetch_channel_key_recipients"
	TypeFetchChannelKeyRecipientsAck = "fetch_channel_key_recipients_ack"
)

// PublishChannelKeyPayload uploads ONE member's wrapped space key for a
// channel + key_version. The caller must be a member of the channel, and so
// must RecipientID. Blob is base64 (std) of the suite-defined wrap; the
// server stores it opaquely and never sees the plaintext space key. WrapSuite
// identifies the construction (see docs/design/crypto-agility.md).
type PublishChannelKeyPayload struct {
	ChannelID   string `json:"channel_id"`
	KeyVersion  int    `json:"key_version,omitempty"` // default 1
	RecipientID string `json:"recipient_id"`
	WrapSuite   int    `json:"wrap_suite"`
	Blob        string `json:"blob"` // base64 std, suite-defined wrap
}

// PublishChannelKeyAckPayload confirms the stored slot.
type PublishChannelKeyAckPayload struct {
	ChannelID   string `json:"channel_id"`
	KeyVersion  int    `json:"key_version"`
	RecipientID string `json:"recipient_id"`
}

// RotateChannelKeyPayload asks the server to advance a channel's current key
// version to NewVersion (phase 25). The caller must be the channel creator and
// NewVersion must be exactly current+1. The new-version wraps must already be
// uploaded via publish_channel_key before this is sent.
type RotateChannelKeyPayload struct {
	ChannelID  string `json:"channel_id"`
	NewVersion int    `json:"new_version"`
}

// RotateChannelKeyAckPayload reports the channel's current key version after a
// successful rotation (== NewVersion).
type RotateChannelKeyAckPayload struct {
	ChannelID         string `json:"channel_id"`
	CurrentKeyVersion int    `json:"current_key_version"`
}

// RemoveMemberPayload removes target_id from a channel (member removal + rotate-
// on-removal). Authz: the channel owner may remove any non-owner; a non-owner
// may remove only themselves (leave). DMs reject removal.
type RemoveMemberPayload struct {
	ChannelID string `json:"channel_id"`
	TargetID  string `json:"target_id"`
}

// RemoveMemberAckPayload confirms a removal.
type RemoveMemberAckPayload struct {
	ChannelID string `json:"channel_id"`
	TargetID  string `json:"target_id"`
}

// AddMemberPayload adds target_id to a channel. Any member may add (invite); the
// target must be a real user. DMs reject adds. The new member gets the current
// key (forward-only access) via a key holder's reshare.
type AddMemberPayload struct {
	ChannelID string `json:"channel_id"`
	TargetID  string `json:"target_id"`
}

// AddMemberAckPayload confirms an add.
type AddMemberAckPayload struct {
	ChannelID string `json:"channel_id"`
	TargetID  string `json:"target_id"`
}

// FetchChannelKeyPayload requests the CALLER's own wrapped key for a channel
// + key_version. The recipient is always the authenticated caller; there is
// no way to fetch another member's wrapped key.
type FetchChannelKeyPayload struct {
	ChannelID  string `json:"channel_id"`
	KeyVersion int    `json:"key_version,omitempty"` // default 1
}

// FetchChannelKeyAckPayload returns the caller's wrapped key. Found is false
// when no wrap exists yet (the caller must wait for an online member to wrap
// it). The client unwraps Blob with their X25519 private key.
type FetchChannelKeyAckPayload struct {
	Found      bool   `json:"found"`
	ChannelID  string `json:"channel_id"`
	KeyVersion int    `json:"key_version,omitempty"`
	WrapSuite  int    `json:"wrap_suite,omitempty"`
	Blob       string `json:"blob,omitempty"` // base64 std
}

// FetchChannelKeyRecipientsPayload asks which members already have a wrapped
// key for (channel, key_version). The caller must be a member. The client
// diffs Recipients against the channel member list to find who still needs
// the key, then wraps it for them ("online-member auto-rewrap").
type FetchChannelKeyRecipientsPayload struct {
	ChannelID  string `json:"channel_id"`
	KeyVersion int    `json:"key_version,omitempty"` // default 1
}

// FetchChannelKeyRecipientsAckPayload lists the user_ids that already hold a
// wrap. The server reports only WHO has a key, never the keys themselves.
type FetchChannelKeyRecipientsAckPayload struct {
	ChannelID  string   `json:"channel_id"`
	KeyVersion int      `json:"key_version"`
	Recipients []string `json:"recipients"`
}

// PublishIdentityPayload uploads the caller's own identity public keys.
// All three byte fields are base64 (std) encoded over the wire. The
// server enforces lengths (32/32/64) and stores under the caller's user.
type PublishIdentityPayload struct {
	Generation int    `json:"generation,omitempty"` // default 1
	X25519Pub  string `json:"x25519_pub"`           // b64, 32 bytes
	Ed25519Pub string `json:"ed25519_pub"`          // b64, 32 bytes
	SelfSig    string `json:"self_sig"`             // b64, 64 bytes (Ed25519 over x25519_pub)
}

// PublishIdentityAckPayload confirms the stored generation.
type PublishIdentityAckPayload struct {
	Generation int `json:"generation"`
}

// FetchIdentityPayload requests another user's current active identity.
type FetchIdentityPayload struct {
	UserID string `json:"user_id"`
}

// FetchIdentityAckPayload returns the active identity. Found is false
// when the target user has not published one yet (keys empty). The
// client MUST verify SelfSig before trusting X25519Pub.
type FetchIdentityAckPayload struct {
	Found      bool   `json:"found"`
	UserID     string `json:"user_id"`
	Generation int    `json:"generation,omitempty"`
	X25519Pub  string `json:"x25519_pub,omitempty"`
	Ed25519Pub string `json:"ed25519_pub,omitempty"`
	SelfSig    string `json:"self_sig,omitempty"`
}

// PrefsGetPayload is empty -- the calling user is identified by the
// connection's authenticated user_id.
type PrefsGetPayload struct{}

// PrefsSetPayload carries a JSON object that is shallow-merged into
// the stored prefs server-side. Keys missing from the patch are
// preserved unchanged.
type PrefsSetPayload struct {
	Patch map[string]any `json:"patch"`
}

// PrefsAckPayload carries the merged result back to clients. Used by
// both prefs_get_ack, prefs_set_ack, and prefs_changed -- same shape
// keeps the SPA's handler logic tight.
type PrefsAckPayload struct {
	Prefs map[string]any `json:"prefs"`
}

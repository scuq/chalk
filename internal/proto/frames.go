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
	// RotationDueFrom (83-5): the key version a membership shrink happened
	// at, absent when no rotation is due. The atomic rotate_channel_key must
	// present it as expected_version; sends are gated while it is set.
	RotationDueFrom *int `json:"rotation_due_from,omitempty"`
	// GovernanceMode is the channel's governance mode ("dictator"|"democratic",
	// gov-1a/gov-2). Lets the client render the mode and gate unilateral vs
	// proposal-based actions. Absent from older servers -> treat as "dictator".
	GovernanceMode string `json:"governance_mode,omitempty"`
	// ChannelType is 'text' or 'voice' (30-1). Absent from older servers ->
	// treat as "text".
	ChannelType string `json:"channel_type,omitempty"`
	// GroupName is the creator's roster-grouping suggestion (54-2). Absent
	// from older servers -> treat as "General".
	GroupName string `json:"group_name,omitempty"`
	// ExpiresAt (unix-millis) is when an ephemeral channel is destroyed
	// (80-6). Absent/0 = permanent. The client renders the countdown from
	// this; the server's janitor is what actually enforces it.
	ExpiresAt int64 `json:"expires_at,omitempty"`
	// LastSeq is the highest seq assigned in the channel, 0 when empty.
	// LastReadSeq is the recipient's read cursor (33-1). The client shows an
	// unread indicator when LastSeq > LastReadSeq, without fetching history.
	LastSeq     int64 `json:"last_seq"`
	LastReadSeq int64 `json:"last_read_seq"`
	// 62-2: newest-message activity for the unified conversation list
	// (Zuckermode). LastMsgBody is CIPHERTEXT the server cannot read,
	// shipped so the client can decrypt a preview without fetching history
	// (the ThreadInboxEntry precedent). All absent when the channel has no
	// messages -- and on channel_event pushes, which don't run the listing
	// query; clients must merge monotonically by LastMsgSeq.
	LastMsgID         string `json:"last_msg_id,omitempty"`
	LastMsgSeq        int64  `json:"last_msg_seq,omitempty"`
	LastMsgTS         int64  `json:"last_msg_ts,omitempty"` // unix-millis
	LastMsgSender     string `json:"last_msg_sender_user_id,omitempty"`
	LastMsgBody       string `json:"last_msg_body,omitempty"`
	LastMsgKeyVersion int    `json:"last_msg_key_version,omitempty"`
	LastMsgDeleted    bool   `json:"last_msg_deleted,omitempty"`
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
	// ChannelType requests 'text' (default when empty) or 'voice' (30-1).
	// A DM cannot be a voice channel.
	ChannelType string `json:"channel_type,omitempty"`
	// GroupName is the creator's roster-grouping suggestion (54-2). Empty
	// means 'General'. Trimmed; ≤80 chars like Name. Set once at creation --
	// per-user regrouping is a client prefs concern, not a server mutation.
	GroupName string `json:"group_name,omitempty"`
	// TTLSecs, when > 0, makes the channel EPHEMERAL (80-6): it is destroyed,
	// contents and guests included, TTLSecs after creation. Relative rather
	// than an absolute timestamp so client clock skew cannot shorten (or
	// stretch) a room's life. Requires channel_type='voice', no DM; the
	// server clamps it to CHALK_EPHEMERAL_MAX_TTL_HOURS and forces
	// governance to 'dictator'.
	TTLSecs int64 `json:"ttl_secs,omitempty"`
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
	// HeadsOnly excludes thread replies from the page (55-2). Scrollback
	// paging sets it so every page is limit VISIBLE rows -- the main feed
	// renders only thread heads, and in a thread-heavy channel a full page
	// could otherwise be almost entirely replies the client filters out.
	// The initial (no BeforeSeq) fetch deliberately doesn't: replies there
	// feed the client's mention scan and warm the newest threads. Default
	// false, so older clients and servers are byte-compatible either way.
	HeadsOnly bool `json:"heads_only,omitempty"`
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
//   - "added":          the caller was added to a channel (created by someone
//     else). Channel summary attached.
//   - "removed":        the caller was removed from a channel. Channel summary
//     may be partial (just the ID) since the caller no longer
//     has read access.
//   - "member_added":   the channel's roster gained a member (the summary is
//     the new roster; the recipient may be the new member).
//   - "member_removed": the roster lost a member.
//   - "rotate_needed":  sent to the owner after a removal; rotate the key.
//   - "key_rotated":    the channel advanced to a new current_key_version.
//   - "key_available":  a holder deposited the caller's wrapped space key
//     (38-3). Summary carries only ID + CurrentKeyVersion --
//     enough to re-run the key fetch, nothing to fold into
//     the channel row.
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
	// 83-5: a membership shrink left the channel due for rotation; sends
	// under the current (or an older) key are refused until the next
	// sender rotates atomically. The message names the version to rotate
	// from; the summary carries it as rotation_due_from.
	ErrCodeRotationRequired = "rotation_required"
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
	// 83-4: every generation of a user's identity, retired ones included,
	// with the chalk-idgen.v1 certs that link them -- the chain a client
	// walks from generation 1 to the key it has pinned.
	TypeFetchIdentityChain    = "fetch_identity_chain"
	TypeFetchIdentityChainAck = "fetch_identity_chain_ack"

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

	// Phase 26 (governance prereq): message deletion. delete_message is a
	// client request (owner-only, dictator-style); message_deleted is the
	// server's per-channel push telling members to tombstone the message.
	TypeDeleteMessage    = "delete_message"
	TypeDeleteMessageAck = "delete_message_ack"
	TypeMessageDeleted   = "message_deleted"

	// Phase 37-2: message edits. edit_message is a client request (sender-only,
	// inside a 15-minute window); message_edited is the server's per-channel
	// push carrying the new ciphertext so members swap the body in place.
	TypeEditMessage    = "edit_message"
	TypeEditMessageAck = "edit_message_ack"
	TypeMessageEdited  = "message_edited"

	// Phase 37-4: reactions. set_reactions replaces the CALLER's whole emoji
	// set for one message (an empty body clears it); reaction_update is the
	// per-channel push carrying one member's new set; fetch_reactions
	// backfills a batch of messages after a history fetch.
	TypeSetReactions      = "set_reactions"
	TypeSetReactionsAck   = "set_reactions_ack"
	TypeReactionUpdate    = "reaction_update"
	TypeFetchReactions    = "fetch_reactions"
	TypeFetchReactionsAck = "fetch_reactions_ack"

	// 83-3: append-only edit revisions. fetch_revisions returns the displaced
	// ciphertexts of one edited message, oldest first, so a client can verify
	// the signed revision chain (each edit envelope's prev_rev_hash) back to
	// the original. Read-only; the write side is the edit transaction itself.
	TypeFetchRevisions    = "fetch_revisions"
	TypeFetchRevisionsAck = "fetch_revisions_ack"

	// Phase 33-1: read cursors. mark_read raises the caller's cursor for a
	// channel; read_state is the push that carries the new cursor to the
	// same user's OTHER connections so the unread dot clears everywhere.
	TypeMarkRead    = "mark_read"
	TypeMarkReadAck = "mark_read_ack"
	TypeReadState   = "read_state"

	// Phase 42-4: thread read cursors. Same three-frame shape as 33-1's
	// channel cursors, one level down: mark_thread_read raises the caller's
	// cursor for one thread, thread_read_state is the push that carries it to
	// the same user's other devices so a thread badge cleared on a phone is
	// cleared on a laptop.
	TypeMarkThreadRead    = "mark_thread_read"
	TypeMarkThreadReadAck = "mark_thread_read_ack"
	TypeThreadReadState   = "thread_read_state"

	// Phase 42-6: the cross-channel thread inbox. One request returns both
	// halves of the answer -- threads active inside the recency window, and
	// threads the caller took part in that have an unread reply at any age --
	// already ordered newest-first, because the two sets cannot overlap.
	TypeThreadInbox    = "thread_inbox"
	TypeThreadInboxAck = "thread_inbox_ack"

	// Phase 43-1: typing indicators. Two frames, not three: typing is
	// fire-and-forget, so there is no ack -- a client that is over the
	// server's rate limit, or is not a member, simply sees nothing happen.
	// typing_update is the push to the channel's OTHER members; the typist's
	// own devices never receive it.
	TypeTyping       = "typing"
	TypeTypingUpdate = "typing_update"
)

// MarkReadPayload raises the caller's read cursor for one channel. Seq is
// the highest message seq the user has seen. The server clamps it to the
// channel's last assigned seq and never lets the cursor move backwards, so
// resends and out-of-order acks are harmless.
type MarkReadPayload struct {
	ChannelID string `json:"channel_id"`
	Seq       int64  `json:"seq"`
}

// ReadStatePayload reports a channel's read cursor. Used both as the
// mark_read ack (carrying the effective, possibly clamped, cursor) and as
// the cross-device push.
type ReadStatePayload struct {
	ChannelID   string `json:"channel_id"`
	LastReadSeq int64  `json:"last_read_seq"`
}

// MarkThreadReadPayload raises the caller's read cursor for one thread. Seq is
// the highest REPLY seq the user has seen in it. Clamped to the thread's newest
// reply and never allowed backwards, exactly like MarkReadPayload.
//
// ChannelID is carried for the membership check; the thread id alone is unique,
// but authorization is per channel.
type MarkThreadReadPayload struct {
	ChannelID string `json:"channel_id"`
	ThreadID  string `json:"thread_id"`
	Seq       int64  `json:"seq"`
}

// ThreadReadStatePayload reports a thread's read cursor. Used both as the
// mark_thread_read ack (carrying the effective, possibly clamped, cursor) and
// as the cross-device push.
type ThreadReadStatePayload struct {
	ChannelID   string `json:"channel_id"`
	ThreadID    string `json:"thread_id"`
	LastReadSeq int64  `json:"last_read_seq"`
}

// ThreadInboxPayload requests a page of the thread inbox.
type ThreadInboxPayload struct {
	// BeforeTS pages backwards through last_reply_ts (server unix-millis).
	// 0 = newest. The cursor is a ts, not a seq: seq is per-channel and this
	// list spans channels, so seq gives no cross-channel ordering.
	BeforeTS int64 `json:"before_ts,omitempty"`
	Limit    int   `json:"limit,omitempty"`
}

// ThreadInboxEntry is one thread worth looking at. Head and newest-reply
// previews are carried as the same body + key_version pair a MessagePayload
// uses; the server has read neither.
type ThreadInboxEntry struct {
	ChannelID string `json:"channel_id"`
	ThreadID  string `json:"thread_id"`

	HeadSeq        int64  `json:"head_seq"`
	HeadTS         int64  `json:"head_ts"`
	HeadSender     string `json:"head_sender_user_id,omitempty"`
	HeadBody       string `json:"head_body,omitempty"`
	HeadKeyVersion *int   `json:"head_key_version,omitempty"`
	HeadDeleted    bool   `json:"head_deleted,omitempty"`

	LastReplySeq        int64  `json:"last_reply_seq"`
	LastReplyTS         int64  `json:"last_reply_ts"`
	LastReplySender     string `json:"last_reply_sender_user_id,omitempty"`
	LastReplyBody       string `json:"last_reply_body,omitempty"`
	LastReplyKeyVersion *int   `json:"last_reply_key_version,omitempty"`
	LastReplyDeleted    bool   `json:"last_reply_deleted,omitempty"`

	ReplyCount  int64 `json:"reply_count"`
	LastReadSeq int64 `json:"last_read_seq"`
	// Involved: the caller wrote the head or one of the replies. Computed from
	// sender_device_id -> user_id, so it needs no plaintext. It is the server's
	// half of "is this thread relevant to me"; the client's half is mentions,
	// which only a decrypted body can answer.
	Involved bool `json:"involved"`
}

// ThreadInboxAckPayload carries one page plus the totals the badge needs.
//
// The two lists are separate rather than concatenated because they answer
// different questions and must not be able to suppress one another: Active is
// discovery (bounded by the recency window, paginated), AgedUnread is the safety
// net (bounded by involvement, first page only). Merging them would let a busy
// user's live threads push a forgotten unread one off the page, which is the
// failure the whole feature exists to prevent.
type ThreadInboxAckPayload struct {
	// Active: a reply inside the recency window, involved or not. Newest first.
	Active []ThreadInboxEntry `json:"active"`
	// AgedUnread: the caller took part, has not read the newest reply, and the
	// thread went quiet before the cutoff. Newest first. Sent with the first
	// page only; empty on subsequent pages.
	AgedUnread []ThreadInboxEntry `json:"aged_unread,omitempty"`
	// UnreadInvolvedTotal counts involved threads with an unread reply at ANY
	// age, ignoring both limits, so the dot stays honest when either list is
	// truncated.
	UnreadInvolvedTotal int `json:"unread_involved_total"`
	// ActiveWindowHours echoes CHALK_THREAD_ACTIVE_WINDOW_HOURS so the client
	// can label the list without a second knob to keep in sync.
	ActiveWindowHours int `json:"active_window_hours"`
	// HasMoreActive: another page sits behind the oldest Active row. Page with
	// before_ts = that row's last_reply_ts.
	HasMoreActive bool `json:"has_more_active"`
}

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
	ChannelID string `json:"channel_id"`
	// NewVersion is the pre-83 two-step form: wraps already parked at
	// new_version via publish_channel_key, creator-only. Still accepted from
	// old clients; new clients use the atomic form below.
	NewVersion int `json:"new_version,omitempty"`
	// 83-5: the atomic form. ExpectedVersion is the current version the
	// responder built against; Wraps carries one SIGNED wrap of the new key
	// per current member -- exactly the roster, no more, no fewer. The
	// server inserts them all and advances to expected+1 in one transaction,
	// or refuses with stale_key_version naming the current version.
	ExpectedVersion int                `json:"expected_version,omitempty"`
	Wraps           []RotationWrapWire `json:"wraps,omitempty"`
}

// RotationWrapWire is one recipient's wrap inside the atomic rotation.
type RotationWrapWire struct {
	RecipientID string `json:"recipient_id"`
	WrapSuite   int    `json:"wrap_suite"`
	Blob        string `json:"blob"` // b64
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

// DeleteMessagePayload asks the server to delete a message (governance prereq).
// Authz: dictator-style -- only the channel OWNER may delete (the democratic
// delete_message proposal type wraps this later). TS is the message's
// server-assigned timestamp in unix-millis (the wire carries ts on every
// message); the server needs it to locate the row in the ts-partitioned table.
type DeleteMessagePayload struct {
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
	TS        int64  `json:"ts"` // unix-millis of the target message
}

// DeleteMessageAckPayload confirms a deletion (or an idempotent re-delete).
type DeleteMessageAckPayload struct {
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
}

// MessageDeletedPayload is the per-channel push emitted after a successful
// delete. Members tombstone the message locally (replace the body with a
// "message deleted" placeholder). Seq lets clients locate the row without a
// ts lookup; DeletedBy/DeletedAt mirror the stored tombstone for audit display.
type MessageDeletedPayload struct {
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
	Seq       int64  `json:"seq"`
	DeletedBy string `json:"deleted_by,omitempty"`
	DeletedAt int64  `json:"deleted_at,omitempty"` // server unix-millis
}

// EditMessagePayload replaces a message's body with newly encrypted content.
// TS is the target's server-assigned timestamp in unix-millis, needed to
// locate the row in the ts-partitioned table (same as DeleteMessagePayload).
// Body is base64 ciphertext and KeyVersion the channel key version it was
// encrypted under -- both validated exactly like a fresh send, so an edit can
// never introduce plaintext or a key version the channel has not reached.
//
// Authz (enforced in handleEditMessage): the caller must be the message's
// sender, the message must not be tombstoned, and it must be younger than the
// edit window. There is no owner override and no governance path -- editing
// someone else's words is not a thing anyone gets to do, by vote or otherwise.
type EditMessagePayload struct {
	ChannelID  string `json:"channel_id"`
	MessageID  string `json:"message_id"`
	TS         int64  `json:"ts"` // unix-millis of the target message
	Body       string `json:"body"`
	KeyVersion int    `json:"key_version"`
}

// EditMessageAckPayload confirms an edit.
type EditMessageAckPayload struct {
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
	EditedAt  int64  `json:"edited_at"` // server unix-millis
}

// MessageEditedPayload is the per-channel push emitted after a successful
// edit. Unlike MessageDeletedPayload (a routing pointer -- there is nothing to
// carry once a body is scrubbed) this carries the new ciphertext inline, so
// members swap the body in place without a re-fetch. Seq lets clients locate
// the row; it is unchanged by an edit, and saying so on the wire is what lets
// the client update in place instead of re-sorting.
type MessageEditedPayload struct {
	ChannelID  string `json:"channel_id"`
	MessageID  string `json:"message_id"`
	Seq        int64  `json:"seq"`
	Body       string `json:"body"`
	KeyVersion int    `json:"key_version"`
	EditedAt   int64  `json:"edited_at"` // server unix-millis
}

// SetReactionsPayload replaces the caller's ENTIRE reaction set for one
// message. There is no add/remove verb: the client sends the set it wants,
// which makes toggling idempotent and removes any add-vs-remove race between
// a member's own devices.
//
// Body is base64 of the sealed JSON array of emoji, encrypted under the
// channel space key exactly like a message body -- the server stores opaque
// bytes and never learns which emoji were picked. An EMPTY body means "no
// reactions from me on this message" and deletes the row.
//
// TS is the target message's unix-millis, needed to locate the row in the
// ts-partitioned table and to fill the reaction's composite foreign key.
type SetReactionsPayload struct {
	ChannelID  string `json:"channel_id"`
	MessageID  string `json:"message_id"`
	TS         int64  `json:"ts"`
	Body       string `json:"body"`                  // base64; "" clears
	KeyVersion int    `json:"key_version,omitempty"` // omitted when clearing
}

// SetReactionsAckPayload confirms the stored (or cleared) set.
type SetReactionsAckPayload struct {
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
}

// ReactionWire is one member's sealed reaction set for one message. Body is
// empty when that member has cleared their reactions -- the push still goes
// out so other clients drop them from the tally.
type ReactionWire struct {
	MessageID  string `json:"message_id"`
	TS         int64  `json:"ts"` // the message's unix-millis
	UserID     string `json:"user_id"`
	Body       string `json:"body,omitempty"`
	KeyVersion int    `json:"key_version,omitempty"`
}

// ReactionUpdatePayload is the per-channel push after a set_reactions. It
// carries the reactor's full set inline rather than a routing pointer:
// reactions are high-frequency and tiny, so a re-fetch per push per instance
// would be pure overhead.
type ReactionUpdatePayload struct {
	ChannelID string       `json:"channel_id"`
	Reaction  ReactionWire `json:"reaction"`
}

// FetchReactionsPayload asks for every reaction on a batch of messages. Sent
// once after a history fetch rather than per message: history responses don't
// carry reactions, and the live push only covers changes from here on.
type FetchReactionsPayload struct {
	ChannelID  string   `json:"channel_id"`
	MessageIDs []string `json:"message_ids"`
}

// FetchRevisionsPayload requests the displaced bodies of one edited message
// (83-3). TS is the message's server timestamp in unix-millis, needed to
// address the ts-partitioned row exactly like EditMessagePayload.
type FetchRevisionsPayload struct {
	ChannelID string `json:"channel_id"`
	MessageID string `json:"message_id"`
	TS        int64  `json:"ts"`
}

// RevisionWire is one displaced ciphertext. RevSeq counts from 1 in
// displacement order (1 = the original body). Body is base64 ciphertext
// exactly as the message body was stored; KeyVersion 0 means the displaced
// row was pre-encryption legacy plaintext.
type RevisionWire struct {
	RevSeq      int    `json:"rev_seq"`
	Body        string `json:"body"`
	KeyVersion  int    `json:"key_version,omitempty"`
	DisplacedAt int64  `json:"displaced_at"` // server unix-millis
}

// FetchRevisionsAckPayload returns the revisions oldest-first. An empty list
// means the message has never been edited (or its revisions were purged with
// its tombstone).
type FetchRevisionsAckPayload struct {
	ChannelID string         `json:"channel_id"`
	MessageID string         `json:"message_id"`
	Revisions []RevisionWire `json:"revisions"`
}

// FetchReactionsAckPayload returns every reaction row for the requested
// messages. Messages with no reactions are simply absent.
type FetchReactionsAckPayload struct {
	ChannelID string         `json:"channel_id"`
	Reactions []ReactionWire `json:"reactions"`
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
//
// 82-6: WrapSuites maps each recipient to the wrap suite their stored wrap was
// produced under, so a key holder can spot members still sitting on a legacy
// unsigned (suite-1) wrap and re-wrap them signed -- the self-healing sweep.
// A recipient absent from the map (older server) is treated as suite unknown,
// which the sweep leaves alone.
type FetchChannelKeyRecipientsAckPayload struct {
	ChannelID  string         `json:"channel_id"`
	KeyVersion int            `json:"key_version"`
	Recipients []string       `json:"recipients"`
	WrapSuites map[string]int `json:"wrap_suites,omitempty"`
}

// PublishIdentityPayload uploads the caller's own identity public keys.
// All three byte fields are base64 (std) encoded over the wire. The
// server enforces lengths (32/32/64) and stores under the caller's user.
type PublishIdentityPayload struct {
	Generation int    `json:"generation,omitempty"` // default 1
	X25519Pub  string `json:"x25519_pub"`           // b64, 32 bytes
	Ed25519Pub string `json:"ed25519_pub"`          // b64, 32 bytes
	SelfSig    string `json:"self_sig"`             // b64, 64 bytes (Ed25519 over x25519_pub)
	// GenCert (83-4): b64 of the 64-byte chalk-idgen.v1 cert signed by the
	// generation being retired. REQUIRED for generation >= 2 -- the publish
	// is then an atomic rotation (store.RotateIdentityKey); ignored for
	// generation 1.
	GenCert string `json:"gen_cert,omitempty"`
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

// FetchIdentityChainPayload asks for every generation of one user's identity
// (83-4).
type FetchIdentityChainPayload struct {
	UserID string `json:"user_id"`
}

// IdentityGenerationWire is one generation of the chain. GenCert is empty
// for generation 1 (a chain root) and for a generation that started a new
// chain after key loss; RetiredAt is 0 for the active generation.
type IdentityGenerationWire struct {
	Generation int    `json:"generation"`
	X25519Pub  string `json:"x25519_pub"`
	Ed25519Pub string `json:"ed25519_pub"`
	SelfSig    string `json:"self_sig"`
	GenCert    string `json:"gen_cert,omitempty"`
	RetiredAt  int64  `json:"retired_at,omitempty"` // unix-millis
}

// FetchIdentityChainAckPayload returns the generations oldest first. Found
// is false when the user has published nothing. The client verifies the
// chain itself; the server never does.
type FetchIdentityChainAckPayload struct {
	Found       bool                     `json:"found"`
	UserID      string                   `json:"user_id"`
	Generations []IdentityGenerationWire `json:"generations"`
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

// TypingPayload says "I am composing in this channel, right now". Nothing is
// persisted and there is no ack; the client re-sends every few seconds while
// composing and simply stops when it stops.
//
// ThreadID is carried but currently unused: the thread composer does not send
// typing and receivers drop any update that names a thread. It is on the wire
// from the start so adding thread indicators later needs no protocol change.
type TypingPayload struct {
	ChannelID string `json:"channel_id"`
	ThreadID  string `json:"thread_id,omitempty"`
}

// TypingUpdatePayload is the push naming who is composing. Receivers hold the
// entry for a few seconds and drop it unless another update refreshes it, so a
// client that disappears mid-sentence ages out on its own.
type TypingUpdatePayload struct {
	ChannelID string `json:"channel_id"`
	ThreadID  string `json:"thread_id,omitempty"`
	UserID    string `json:"user_id"`
}

const (
	// TypeServerNotice is an unsolicited announcement about the server
	// itself rather than about any channel or user. Kind carries the
	// specific event, so later notices (maintenance window, read-only
	// mode) reuse one frame type and one client dispatch case.
	TypeServerNotice = "server_notice"

	// NoticeRestarting: this process is going down and the socket is about
	// to close. It says nothing about whether the build that comes back
	// differs -- the next welcome frame's version settles that.
	NoticeRestarting = "restarting"
)

// ServerNoticePayload names the notice and the build that emitted it.
// Version/Commit duplicate the welcome frame's fields on purpose: a client
// logging the notice can say which build told it, without holding welcome
// state, and it costs two short strings.
type ServerNoticePayload struct {
	Kind    string `json:"kind"`
	Version string `json:"version,omitempty"`
	Commit  string `json:"commit,omitempty"`
}

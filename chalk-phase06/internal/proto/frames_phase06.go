package proto

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
//   not_found       -- user doesn't exist or is soft_blocked/deleted
//   not_a_friend    -- exists, but no accepted friendship with the caller
//   self            -- can't subscribe to your own presence
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
//   request_received  -- someone sent you a friend request
//   accepted          -- someone accepted your request, or your request
//                        auto-promoted an existing one
//   declined          -- someone declined your request
//   removed           -- someone removed you from their friends
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

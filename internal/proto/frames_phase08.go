package proto

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
	ID         string   `json:"id"`
	Name       string   `json:"name"`
	IsDM       bool     `json:"is_dm"`
	CreatedBy  string   `json:"created_by"` // user_id; empty for system channels
	CreatedAt  int64    `json:"created_at"` // unix-millis
	MemberIDs  []string `json:"member_ids"` // small; included in summary for DM-name rendering
	Members   []ChannelMember `json:"members"`    // phase 08c; pairs user_id with handle
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
//   * Name required, non-empty after trim, ≤80 chars.
//   * IsDM=true requires exactly one OTHER user (so the channel has
//     exactly 2 members total including the caller).
//   * All MemberIDs must be friends of the caller (per phase 06 friends).
//   * Non-friend / non-existent IDs cause the entire create to fail.
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
//   * BeforeSeq: return messages with seq < BeforeSeq, in descending seq
//     order. Omit (zero value) to fetch from the newest message.
//   * Limit: cap on rows returned. Server enforces a hard ceiling of 200
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
//   * "added":   the caller was added to a channel (created by someone
//                else). Channel summary attached.
//   * "removed": the caller was removed from a channel. Channel summary
//                may be partial (just the ID) since the caller no longer
//                has read access.
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
	ErrCodeInvalidChannel  = "invalid_channel"
	ErrCodeDMCardinality   = "dm_cardinality"
)

package proto

import "encoding/json"

// gov-1b wire surface: governance mode change + the proposal lifecycle
// (propose / vote / cancel / list) and the governance_event push. Kept in its
// own file so the large frames.go is untouched.
//
// gov-1b-1 (this slice) carries the full lifecycle and resolve-to-status; the
// action execution on a passed proposal, the set_mode ratchet, mode
// enforcement on the unilateral handlers, and the expiry sweeper arrive in
// gov-1b-2.

const (
	// gov_set_mode: owner changes a channel's governance mode. gov-1b-1
	// supports only the unilateral dictator->democratic direction; the
	// democratic->dictator ratchet (a supermajority set_mode proposal) is
	// gov-1b-2.
	TypeGovSetMode    = "gov_set_mode"
	TypeGovSetModeAck = "gov_set_mode_ack"

	// gov_propose / gov_vote / gov_cancel / gov_list_proposals: the proposal
	// lifecycle. Pushed updates ride the governance_event frame.
	TypeGovPropose    = "gov_propose"
	TypeGovProposeAck = "gov_propose_ack"
	TypeGovVote       = "gov_vote"
	TypeGovVoteAck    = "gov_vote_ack"
	TypeGovCancel     = "gov_cancel"
	TypeGovCancelAck  = "gov_cancel_ack"
	TypeGovList       = "gov_list_proposals"
	TypeGovListAck    = "gov_list_proposals_ack"

	// governance_event: server push for mode changes and proposal state. The
	// Kind field discriminates (see the GovEvent* constants).
	TypeGovernanceEvent = "governance_event"
)

// Governance event sub-kinds (carried in GovernanceEventPayload.Kind and,
// on the wire envelope, in pubsub.Event.FriendKind).
const (
	GovEventModeChanged      = "mode_changed"
	GovEventProposalOpened   = "proposal_opened"
	GovEventProposalUpdated  = "proposal_updated"
	GovEventProposalResolved = "proposal_resolved"
)

// Governance error codes.
const (
	ErrCodeNotDemocratic       = "not_democratic"        // proposals require democratic mode
	ErrCodeModeChangeForbidden = "mode_change_forbidden" // e.g. democratic->dictator needs a proposal
	ErrCodeBadMode             = "bad_mode"              // mode not dictator|democratic
	ErrCodeBelowFloor          = "below_floor"           // snapshot smaller than min_eligible
	ErrCodeProposalExists      = "proposal_exists"       // one already open for (channel,type,target)
	ErrCodeReproposeCooldown   = "repropose_cooldown"    // recently failed; in cooldown
	ErrCodeTooManyProposals    = "too_many_proposals"    // author open-proposal rate limit
	ErrCodeNotEligible         = "not_eligible"          // voter not in the frozen snapshot
	ErrCodeProposalClosed      = "proposal_closed"       // not open (already resolved)
	ErrCodeProposalNotFound    = "proposal_not_found"
	ErrCodeBadVote             = "bad_vote"            // vote not yes|no
	ErrCodeCancelForbidden     = "cancel_forbidden"    // not the author or owner
	ErrCodeProposalForbidden   = "proposal_forbidden"  // unsupported proposal type in this slice
	ErrCodeProposalBadTarget   = "proposal_bad_target" // target missing/invalid for the type
)

// ProposalView is the wire shape of a proposal: its identity plus the aggregate
// tally (counts only -- per-voter ballots are never shipped, H7). YourVote is
// filled per-recipient where the server knows it (list ack); it is left empty
// in broadcast pushes, where clients track their own vote from the vote ack.
type ProposalView struct {
	ID        string          `json:"id"`
	ChannelID string          `json:"channel_id"`
	Type      string          `json:"type"`
	TargetID  string          `json:"target_id,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
	CreatedBy string          `json:"created_by"`
	CreatedAt string          `json:"created_at"` // RFC3339
	ExpiresAt string          `json:"expires_at"` // RFC3339
	Status    string          `json:"status"`
	Eligible  int             `json:"eligible"`
	Yes       int             `json:"yes"`
	No        int             `json:"no"`
	Voted     int             `json:"voted"`
	YourVote  string          `json:"your_vote,omitempty"` // "yes"|"no"|""
}

// ---- request / ack payloads ------------------------------------------------

type GovSetModePayload struct {
	ChannelID string `json:"channel_id"`
	Mode      string `json:"mode"`
}
type GovSetModeAckPayload struct {
	ChannelID string `json:"channel_id"`
	Mode      string `json:"mode"`
}

type GovProposePayload struct {
	ChannelID string          `json:"channel_id"`
	Type      string          `json:"type"`
	TargetID  string          `json:"target_id,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}
type GovProposeAckPayload struct {
	Proposal ProposalView `json:"proposal"`
}

type GovVotePayload struct {
	ProposalID string `json:"proposal_id"`
	Vote       string `json:"vote"`
}
type GovVoteAckPayload struct {
	ProposalID string `json:"proposal_id"`
	Vote       string `json:"vote"`
}

type GovCancelPayload struct {
	ProposalID string `json:"proposal_id"`
}
type GovCancelAckPayload struct {
	ProposalID string `json:"proposal_id"`
}

type GovListPayload struct {
	ChannelID       string `json:"channel_id"`
	IncludeResolved bool   `json:"include_resolved,omitempty"`
}
type GovListAckPayload struct {
	ChannelID string         `json:"channel_id"`
	Proposals []ProposalView `json:"proposals"`
}

// GovernanceEventPayload is the push body. Mode is set for mode_changed;
// Proposal is set for the proposal_* kinds.
type GovernanceEventPayload struct {
	Kind      string        `json:"kind"`
	ChannelID string        `json:"channel_id"`
	Mode      string        `json:"mode,omitempty"`
	Proposal  *ProposalView `json:"proposal,omitempty"`
}

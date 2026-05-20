package proto

// Phase 11c-1 adds two C->S frames for managing membership of an
// existing MLS channel:
//
//   add_to_channel       -- caller asks chalkd to claim one of the
//                            target's KeyPackages so the caller can
//                            then build an MLS Add commit locally
//                            and ship it via mls_commit_bundle.
//   remove_from_channel  -- caller asks chalkd to authorize a member
//                            removal. Actual member-list mutation
//                            happens later when mls_commit_bundle
//                            lands (PR 3); this handler is just the
//                            permission gate.
//
// Both are PR 2 of phase 11c-1: server-side scaffolding only. PR 3
// (extended mls_commit_bundle) will wire them up to actually mutate
// channel_members and write into mls_commits.
//
// The choice to split "auth/KP-claim" from "actual commit" into two
// round trips matches the existing 11a/11b shape (publish/fetch are
// separate from commit_bundle). Clients can:
//   1. add_to_channel(target) -> KP returned
//   2. cc.addClientsToConversation(channel, [kp]) -> Commit + Welcome
//   3. mls_commit_bundle(commit, welcomes, proposed_adds=[target])
// or abort between (1) and (3) with no harm done (the KP is consumed
// but unused -- accepted waste, see design doc 11c §6.3).

const (
	// Client -> server.
	TypeAddToChannel      = "add_to_channel"
	TypeRemoveFromChannel = "remove_from_channel"

	// Server -> client (acks).
	TypeAddToChannelAck      = "add_to_channel_ack"
	TypeRemoveFromChannelAck = "remove_from_channel_ack"
)

// AddToChannelPayload (C->S). The caller (must be a member of the
// channel) asks chalkd to claim one of target_user_id's KeyPackages
// so the caller can build an MLS Add commit.
//
// Server validates:
//   - channel exists and is MLS (is_mls=true)
//   - caller is a current member
//   - target is NOT a current member
//   - caller and target are accepted friends
//   - target has at least one unused KeyPackage
//
// On success, the server consumes one KP for the target (sets
// used_at = NOW()) and returns it in the ack. The caller is then
// expected to send mls_commit_bundle with proposed_adds=[target];
// PR 3 will validate that bundle against this declared change.
type AddToChannelPayload struct {
	ChannelID    string `json:"channel_id"`     // UUID
	TargetUserID string `json:"target_user_id"` // UUID of the user to add
	Ciphersuite  int    `json:"ciphersuite,omitempty"`
}

// AddToChannelAckPayload (S->C). Returns the claimed KP for the
// caller to feed into CoreCrypto's addClientsToConversation.
type AddToChannelAckPayload struct {
	ChannelID    string `json:"channel_id"`
	TargetUserID string `json:"target_user_id"`
	// The claimed KP. Shape matches FetchedKeyPackage from phase 11a's
	// fetch_key_packages_ack so client code can share decoding logic.
	KeyPackage FetchedKeyPackage `json:"key_package"`
}

// RemoveFromChannelPayload (C->S). The caller asks chalkd to
// authorize removing target_user_id from the MLS channel.
//
// Server validates:
//   - channel exists and is MLS
//   - caller is a current member
//   - target IS a current member
//   - permission rule (design doc 11c §7.2):
//       * target == caller   -> always allowed (leave-self)
//       * target != caller   -> caller must be the channel creator
//
// On success, the ack is just a green light. The caller then builds
// the MLS Remove commit and sends mls_commit_bundle with
// proposed_removes=[target]; PR 3's bundle handler will mutate
// channel_members at that point.
//
// Note that the actual MLS removal is the client's responsibility.
// chalkd can't initiate or enforce removal cryptographically -- if
// the caller never sends the follow-up mls_commit_bundle, the
// target stays in the group. This is by design: the server is a
// relay, not an MLS participant.
type RemoveFromChannelPayload struct {
	ChannelID    string `json:"channel_id"`
	TargetUserID string `json:"target_user_id"`
}

// RemoveFromChannelAckPayload (S->C). Authorization confirmation
// only. Echoes the IDs back so the client can correlate.
type RemoveFromChannelAckPayload struct {
	ChannelID    string `json:"channel_id"`
	TargetUserID string `json:"target_user_id"`
}

// Error codes added by phase 11c-1. The mls_ prefix matches the
// existing 11b convention (ErrCodeMlsBadBundle, ErrCodeMlsNotMember).
const (
	// Channel doesn't have is_mls=true; the requested operation
	// only makes sense for MLS-encrypted channels.
	ErrCodeMlsChannelNotEncrypted = "mls_channel_not_encrypted"

	// add_to_channel: target is already in the channel.
	ErrCodeMlsAlreadyMember = "mls_already_member"

	// remove_from_channel: target is not in the channel.
	ErrCodeMlsTargetNotMember = "mls_target_not_member"

	// remove_from_channel: caller tried to remove someone other than
	// themselves but is not the channel creator.
	ErrCodeMlsNotAuthorized = "mls_not_authorized"

	// add_to_channel: target has zero unused KeyPackages on file.
	// The client should surface this as "<target> hasn't logged in
	// recently; they need to come online once before they can be
	// added to encrypted channels." (see design doc 11c §3.1).
	ErrCodeMlsPeerNoKeyPackages = "mls_peer_no_keypackages"

	// Phase 11c-1 PR 3: returned by mls_commit_bundle when the
	// (channel_id, epoch) is already occupied by a different commit
	// (typically because another member committed first). The client
	// must process the winning commit (via the catchup path -- arrives
	// in PR 4) and retry at the new epoch.
	ErrCodeMlsStaleCommit = "mls_stale_commit"

	// Phase 11c-1 PR 3: returned by mls_commit_bundle when the
	// proposed_adds or proposed_removes list contains an entry that
	// was not previously authorized by add_to_channel /
	// remove_from_channel within the 60s validity window. The client
	// should re-authorize and re-commit.
	ErrCodeMlsCommitUnauthorized = "mls_commit_unauthorized"
)

// Phase 11c-1 PR 5: live broadcast of MLS Commits to existing
// channel members + catchup-on-request for late-joining devices.
//
// The mls_commit_event push frame is the live-broadcast and catchup
// vehicle. fetch_mls_commits is the client-initiated catchup
// request. A reconnecting client typically:
//
//   1. Sends hello, receives initial Welcome frame
//   2. drainPendingMlsWelcomes pushes any buffered welcomes (PR 4)
//   3. Client realizes its CoreCrypto epoch for channel X lags
//      what handleMlsCommitBundle ack told it last time
//   4. Client sends fetch_mls_commits(channel_id, after_epoch=last_known)
//   5. Server streams one mls_commit_event per stored commit at
//      epoch > after_epoch, in epoch order
//   6. Server sends fetch_mls_commits_ack with the count

const (
	// S->C push: a new (or historical) MLS Commit for a channel.
	// During live broadcast, sent by handleMlsCommitBundle to all
	// current channel members except the sender and the newly-added
	// members from proposed_adds (those get their initial state via
	// the Welcome path).
	//
	// During catchup, sent by handleFetchMlsCommits in epoch order.
	TypeMlsCommitEvent = "mls_commit_event"

	// C->S request: "send me every commit for this channel with
	// epoch > after_epoch". Server responds with one mls_commit_event
	// per matching commit (in epoch order), then a
	// fetch_mls_commits_ack.
	TypeFetchMlsCommits    = "fetch_mls_commits"
	TypeFetchMlsCommitsAck = "fetch_mls_commits_ack"
)

// MlsCommitEventPayload (S->C). Either a live commit notification
// or a historical catchup commit; the client can't tell them apart
// (and doesn't need to -- both are processed via CoreCrypto's
// decryptMessage path against the local group state).
type MlsCommitEventPayload struct {
	ChannelID         string `json:"channel_id"`
	Epoch             int64  `json:"epoch"`
	// Commit is base64-encoded TLS-serialized Commit bytes,
	// identical in shape to mls_commit_bundle.commit.
	Commit            string `json:"commit"`
	CommittedByUserID string `json:"committed_by_user_id"`
	// CommittedAt is RFC3339 UTC; used by the client for ordering
	// hints and for "this commit happened N minutes ago" UI.
	CommittedAt       string `json:"committed_at"`
}

// FetchMlsCommitsPayload (C->S). Catchup request. Client supplies
// its known epoch for the channel; server streams everything after.
// AfterEpoch may be 0, meaning "give me everything from the
// beginning of stored history."
type FetchMlsCommitsPayload struct {
	ChannelID  string `json:"channel_id"`
	AfterEpoch int64  `json:"after_epoch"`
}

// FetchMlsCommitsAckPayload (S->C). Sent after all matching
// mls_commit_event frames have been pushed. Count tells the client
// how many events to expect (it can compare against what it
// received and detect framing loss; in practice the WS guarantees
// in-order delivery so this is a sanity check).
type FetchMlsCommitsAckPayload struct {
	ChannelID string `json:"channel_id"`
	Count     int    `json:"count"`
}

// chalk wire protocol — TypeScript mirror of internal/proto/proto.go,
// frames_phase06.go, frames_phase08.go, and frames_phase08b.go.
//
// Keep these in lockstep with the Go side. Any time a payload struct
// or type constant changes server-side, update this file. We don't
// auto-generate (would add a build dependency for a tiny amount of
// code) but the surface is small enough to maintain by hand.

export const SUBPROTOCOL = "chalk.v1";

// --- Frame envelope -------------------------------------------------

export interface Frame<P = unknown> {
  type: string;
  ref?: string;
  payload?: P;
}

// --- Phase 04 frame types -------------------------------------------

export const TypeHello = "hello";
export const TypeSend = "send";
export const TypeWelcome = "welcome";
export const TypeMessage = "message";
export const TypeError = "error";

export interface HelloPayload {
  device_id: string;
  device_type?: string;
}

export interface WelcomePayload {
  user_id: string;
  device_id: string;
  handle: string; // phase 08c; empty for anonymous/legacy
  channels: string[];
}

export interface SendPayload {
  channel_id?: string; // phase 08; omitted falls back server-side to default
  body: string;
  // Phase 10a: optional parent message ID for thread replies. When
  // set, server validates the parent and computes thread_id.
  parent_id?: string;
  /** Phase 11b-2: "mls_ciphertext" for encrypted sends; omit for plaintext. */
  content_type?: string;
}

export interface MessagePayload {
  id: string;
  channel_id: string; // phase 08
  seq: number;        // phase 08
  sender: string;     // device_id; legacy field, prefer sender_user_id for display
  // Phase 9.6i: sender's user_id. Optional because old servers
  // don't send it and purged-user messages have no user to map to.
  sender_user_id?: string;
  ts: number;
  body: string;
  // Phase 10a: threading metadata.
  parent_id?: string;
  thread_id?: string;
  reply_count?: number;
  // Phase 10d: highest seq among replies; used for unread badge.
  last_reply_seq?: number;
  // Phase 10e: preview of the most recent reply, for the indicator
  // snippet. Both undefined when there's no thread or no replies.
  last_reply_sender_user_id?: string;
  last_reply_body?: string;
  /** Phase 11b-2: "application" or "mls_ciphertext". Empty = "application". */
  content_type?: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

// --- Phase 06 presence + friends ------------------------------------

export const TypePresence = "presence";
export const TypePresenceSubscribe = "presence_subscribe";
export const TypePresenceSubscribeAck = "presence_subscribe_ack";
export const TypePresenceUnsubscribe = "presence_unsubscribe";
export const TypePresenceUnsubscribeAck = "presence_unsubscribe_ack";
export const TypePresenceUpdate = "presence_update";
export const TypePresenceUpdateAck = "presence_update_ack";

// Phase 9.6c: TS interfaces for the presence payloads. These mirror
// the server-side proto.PresencePayload + proto.PresenceSubscribePayload
// + proto.PresenceSubscribeAckPayload + proto.PresenceRejection.

// Single-user presence state. Sent by the server (push) on subscribe
// confirmation + on subsequent state changes.
export interface PresencePayload {
  user_id: string;
  // "online" | "away" | "offline" -- aggregated across the user's
  // devices, not any single device's state.
  state: string;
  at: number; // unix-millis of most-recent activity
}

// SPA → server: ask to be told about these users' presence.
export interface PresenceSubscribePayload {
  user_ids: string[];
}

// Server → SPA: the result of a subscribe request. Subscribed list
// contains the user_ids actually being tracked. Rejected contains
// per-id refusal reasons (not_found / not_a_friend / self).
export interface PresenceSubscribeAckPayload {
  subscribed: string[];
  rejected: PresenceRejection[];
}

export interface PresenceRejection {
  user_id: string;
  reason: string;
}

// SPA → server: stop being told about these users.
export interface PresenceUnsubscribePayload {
  user_ids: string[];
}

export const TypeFriendRequest = "friend_request";
export const TypeFriendRequestAck = "friend_request_ack";
export const TypeFriendAccept = "friend_accept";
export const TypeFriendAcceptAck = "friend_accept_ack";
export const TypeFriendDecline = "friend_decline";
export const TypeFriendDeclineAck = "friend_decline_ack";
export const TypeFriendRemove = "friend_remove";
export const TypeFriendRemoveAck = "friend_remove_ack";
export const TypeFriendBlock = "friend_block";
export const TypeFriendBlockAck = "friend_block_ack";
export const TypeFriendUnblock = "friend_unblock";
export const TypeFriendUnblockAck = "friend_unblock_ack";
export const TypeFriendList = "friend_list";
export const TypeFriendListAck = "friend_list_ack";
export const TypeFriendEvent = "friend_event";

// phase 08b uses friend_list to populate the create-channel friend picker.
export interface FriendListPayload {} // no fields; server returns the caller's friends

// FriendSummary mirrors proto.FriendSummary. Phase 09 will
// populate `handle` with usernames; today it is empty for
// not-yet-implemented user handles.
export interface FriendSummary {
  user_id: string;
  handle: string;
  account_status: string;
}

// FriendListAckPayload mirrors proto.FriendListAckPayload.
// Server returns four bucketed lists, not a flat array with a
// status discriminator.
export interface FriendListAckPayload {
  pending_outgoing: FriendSummary[];
  pending_incoming: FriendSummary[];
  accepted: FriendSummary[];
  blocked: FriendSummary[];
}

// --- Phase 08 channels ----------------------------------------------

export const TypeCreateChannel = "create_channel";
export const TypeCreateChannelAck = "create_channel_ack";
export const TypeListChannels = "list_channels";
export const TypeListChannelsAck = "list_channels_ack";
export const TypeFetchHistory = "fetch_history";
export const TypeFetchHistoryAck = "fetch_history_ack";
export const TypeChannelEvent = "channel_event";

// phase 08c: ChannelMember pairs a user_id with their handle. The
// server populates `handle` from the users table; empty when unknown.
// SPA prefers `members` over `member_ids` for DM-label rendering.
export interface ChannelMemberWire {
  user_id: string;
  handle: string;
}

export interface ChannelSummaryWire {
  id: string;
  name: string;
  is_dm: boolean;
  /** Phase 11b-2: true iff channel uses MLS encryption. */
  is_mls?: boolean;
  created_by: string;
  created_at: number; // unix-millis
  member_ids: string[];
  members?: ChannelMemberWire[]; // phase 08c; optional for backward compat
}

export interface CreateChannelPayload {
  name: string;
  is_dm?: boolean;
  member_ids?: string[];
}

export interface CreateChannelAckPayload {
  channel: ChannelSummaryWire;
}

export interface ListChannelsPayload {}

export interface ListChannelsAckPayload {
  channels: ChannelSummaryWire[];
}

export interface FetchHistoryPayload {
  channel_id: string;
  before_seq?: number;
  limit?: number;
}

export interface FetchHistoryAckPayload {
  channel_id: string;
  before_seq: number;
  messages: MessagePayload[];
}

export interface ChannelEventPayload {
  kind: string; // "added" | "removed"
  channel: ChannelSummaryWire;
}

// --- Phase 08b: subscribe_channel ----------------------------------

export const TypeSubscribeChannel = "subscribe_channel";
export const TypeSubscribeChannelAck = "subscribe_channel_ack";

export interface SubscribeChannelPayload {
  channel_id: string;
}

export interface SubscribeChannelAckPayload {
  channel_id: string;
}

// --- Error codes ----------------------------------------------------

export const ErrCodeBadFrame = "bad_frame";
export const ErrCodeBadPayload = "bad_payload";
export const ErrCodeUnknownType = "unknown_type";
export const ErrCodeNotHelloed = "not_helloed";
export const ErrCodeInternal = "internal";
export const ErrCodeRateLimited = "rate_limited";
export const ErrCodeFrameTooLarge = "frame_too_large";

export const ErrCodeChannelNotFound = "channel_not_found";
export const ErrCodeNotAMember = "not_a_member";
export const ErrCodeNotFriends = "not_friends";
export const ErrCodeInvalidChannel = "invalid_channel";
export const ErrCodeDMCardinality = "dm_cardinality";

// --- Helpers --------------------------------------------------------

export function newFrame<P>(type: string, payload?: P, ref?: string): Frame<P> {
  const f: Frame<P> = { type };
  if (ref) f.ref = ref;
  if (payload !== undefined) f.payload = payload;
  return f;
}

// ---- Phase 9.7a: user preferences ----------------------------------

export const TypePrefsGet     = "prefs_get";
export const TypePrefsGetAck  = "prefs_get_ack";
export const TypePrefsSet     = "prefs_set";
export const TypePrefsSetAck  = "prefs_set_ack";
export const TypePrefsChanged = "prefs_changed";

export interface PrefsGetPayload {}

export interface PrefsSetPayload {
  patch: Record<string, unknown>;
}

// Ack payload shared by prefs_get_ack, prefs_set_ack, prefs_changed.
export interface PrefsAckPayload {
  prefs: Record<string, unknown>;
}

// ---- Phase 10a: thread fetch ---------------------------------------

export const TypeFetchThread    = "fetch_thread";
export const TypeFetchThreadAck = "fetch_thread_ack";

export interface FetchThreadPayload {
  channel_id: string;
  thread_id: string;
  before_seq?: number;
  limit?: number;
}

export interface FetchThreadAckPayload {
  channel_id: string;
  thread_id: string;
  messages: MessagePayload[];
}

// ---- Phase 11a: MLS KeyPackage publish/fetch ------------------------

export const TypePublishKeyPackages    = "publish_key_packages";
export const TypePublishKeyPackagesAck = "publish_key_packages_ack";
export const TypeFetchKeyPackages      = "fetch_key_packages";
export const TypeFetchKeyPackagesAck   = "fetch_key_packages_ack";
export const TypeKeyPackageCount       = "key_package_count";
export const TypeKeyPackageCountAck    = "key_package_count_ack";

export interface KeyPackageEntry {
  ciphersuite: number;
  credential_type: number;
  client_id_claimed: string;
  /** base64-encoded TLS-serialized KeyPackage bytes */
  key_package_data: string;
}

export interface PublishKeyPackagesPayload {
  key_packages: KeyPackageEntry[];
}

export interface PublishKeyPackagesAckPayload {
  accepted: number;
}

export interface FetchKeyPackagesPayload {
  user_ids: string[];
  ciphersuite?: number;
}

export interface FetchedKeyPackage {
  user_id: string;
  device_id: string;
  client_id: string;
  ciphersuite: number;
  credential_type: number;
  /** base64 */
  key_package_data: string;
}

export interface FetchKeyPackagesAckPayload {
  key_packages: FetchedKeyPackage[];
}

export interface KeyPackageCountPayload {}

export interface KeyPackageCountAckPayload {
  count: number;
}

// ---- Phase 11b-2: MLS commit_bundle + welcome wire ------------------

export const TypeMlsCommitBundle    = "mls_commit_bundle";
export const TypeMlsCommitBundleAck = "mls_commit_bundle_ack";
export const TypeMlsWelcome         = "mls_welcome";
export const TypeMlsWelcomeAck      = "mls_welcome_ack";

export const ContentTypeApplication   = "application";
export const ContentTypeMlsCiphertext = "mls_ciphertext";

export interface WelcomeFor {
  user_id: string;
  /** base64-encoded TLS-serialized Welcome bytes */
  welcome: string;
}

export interface MlsCommitBundlePayload {
  channel_id: string;
  /** base64-encoded opaque group ID */
  mls_group_id: string;
  /** base64-encoded TLS-serialized Commit; optional for group-creation bundles */
  commit?: string;
  welcome_for?: WelcomeFor[];
  epoch: number;
  /** Phase 11c-1 PR 3: declared adds accompanying this commit.
   *  Each entry must match a recent authorization from
   *  add_to_channel (60s TTL, single-use) or the server returns
   *  ErrCodeMlsCommitUnauthorized. */
  proposed_adds?: string[];
  /** Phase 11c-1 PR 3: declared removes (symmetric to proposed_adds). */
  proposed_removes?: string[];
}

export interface MlsCommitBundleAckPayload {
  channel_id: string;
  delivered: number;
}

export interface MlsWelcomePayload {
  channel_id: string;
  mls_group_id: string;
  welcome: string;
  sender_user_id: string;
}

export interface MlsWelcomeAckPayload {
  channel_id: string;
  ok: boolean;
}

// ===================================================================
// Phase 11c-2 PR 2: MLS multi-member channel wire protocol.
// ===================================================================
//
// Mirrors the server-side additions from phases 11c-1 PRs 2, 3, and 5:
//
//   * add_to_channel / remove_from_channel   (C->S, ack S->C)  -- PR 2
//   * mls_stale_commit / mls_commit_unauthorized error codes  -- PR 3
//   * MlsCommitBundlePayload.proposed_adds / proposed_removes -- PR 3
//   * mls_commit_event push                                   -- PR 5
//   * fetch_mls_commits + ack                                 -- PR 5

// ---- add / remove channel membership -------------------------------

export const TypeAddToChannel         = "add_to_channel";
export const TypeAddToChannelAck      = "add_to_channel_ack";
export const TypeRemoveFromChannel    = "remove_from_channel";
export const TypeRemoveFromChannelAck = "remove_from_channel_ack";

/** AddToChannelPayload (C->S). Caller (must be a current channel
 *  member) asks chalkd to claim one of target_user_id's KeyPackages
 *  so the caller can build an MLS Add commit locally. */
export interface AddToChannelPayload {
  channel_id: string;
  target_user_id: string;
  /** Optional; defaults to 1 (MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519). */
  ciphersuite?: number;
}

/** AddToChannelAckPayload (S->C). Returns the claimed KeyPackage. */
export interface AddToChannelAckPayload {
  channel_id: string;
  target_user_id: string;
  key_package: FetchedKeyPackage;
}

/** RemoveFromChannelPayload (C->S). Caller asks chalkd to authorize
 *  removing target_user_id. Pure permission gate; the actual MLS
 *  Remove commit follows in a subsequent mls_commit_bundle with
 *  proposed_removes=[targetUserID]. */
export interface RemoveFromChannelPayload {
  channel_id: string;
  target_user_id: string;
}

/** RemoveFromChannelAckPayload (S->C). Echoes ids; auth confirmed. */
export interface RemoveFromChannelAckPayload {
  channel_id: string;
  target_user_id: string;
}

// ---- mls_commit_event push (live broadcast + catchup) --------------

export const TypeMlsCommitEvent        = "mls_commit_event";
export const TypeFetchMlsCommits       = "fetch_mls_commits";
export const TypeFetchMlsCommitsAck    = "fetch_mls_commits_ack";

/** MlsCommitEventPayload (S->C push). Either a live commit
 *  notification (sent by handleMlsCommitBundle to existing channel
 *  members after a commit is stored) or a historical catchup commit
 *  (sent by handleFetchMlsCommits in epoch order). The client can't
 *  tell them apart and doesn't need to -- both are processed via
 *  CoreCrypto's decryptMessage against the local group state. */
export interface MlsCommitEventPayload {
  channel_id: string;
  epoch: number;
  /** base64-encoded TLS-serialized Commit bytes. */
  commit: string;
  committed_by_user_id: string;
  /** RFC3339 timestamp. */
  committed_at: string;
}

/** FetchMlsCommitsPayload (C->S). Client supplies its known epoch
 *  for the channel; server streams every commit with epoch > after.
 *  after_epoch = 0 means "give me everything from the beginning of
 *  stored history." */
export interface FetchMlsCommitsPayload {
  channel_id: string;
  after_epoch: number;
}

/** FetchMlsCommitsAckPayload (S->C). Sent after all matching
 *  mls_commit_event frames have been pushed. Count is the total
 *  number streamed (sanity check; WS guarantees ordered delivery). */
export interface FetchMlsCommitsAckPayload {
  channel_id: string;
  count: number;
}

// ---- error codes added by phase 11c-1 ------------------------------

/** Channel doesn't have is_mls=true; the requested op only makes
 *  sense for MLS-encrypted channels. */
export const ErrCodeMlsChannelNotEncrypted = "mls_channel_not_encrypted";

/** add_to_channel: target is already in the channel. */
export const ErrCodeMlsAlreadyMember = "mls_already_member";

/** remove_from_channel: target is not in the channel. */
export const ErrCodeMlsTargetNotMember = "mls_target_not_member";

/** remove_from_channel: caller tried to remove someone other than
 *  themselves but is not the channel creator. */
export const ErrCodeMlsNotAuthorized = "mls_not_authorized";

/** add_to_channel: target has zero unused KeyPackages. Surface as
 *  "<target> hasn't logged in recently; they need to come online
 *  once before they can be added to encrypted channels." */
export const ErrCodeMlsPeerNoKeyPackages = "mls_peer_no_keypackages";

/** mls_commit_bundle race-lost: another commit landed first at this
 *  epoch. Client must catchup to the winning commit (via
 *  fetch_mls_commits) and retry at the new epoch. */
export const ErrCodeMlsStaleCommit = "mls_stale_commit";

/** mls_commit_bundle: a proposed_adds or proposed_removes entry was
 *  not previously authorized by add_to_channel / remove_from_channel
 *  within the 60s validity window. Re-authorize and re-commit. */
export const ErrCodeMlsCommitUnauthorized = "mls_commit_unauthorized";


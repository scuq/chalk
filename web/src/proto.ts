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

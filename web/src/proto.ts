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
  // 30-6: server feature flag (CHALK_VOICE_ENABLED). Absent from older
  // servers -> voice UI hidden (the safe default).
  voice_enabled?: boolean;
}

export interface SendPayload {
  channel_id?: string; // phase 08; omitted falls back server-side to default
  body: string;
  // Phase 10a: optional parent message ID for thread replies. When
  // set, server validates the parent and computes thread_id.
  parent_id?: string;
  // Phase 23d: message-suite key version. Omitted/0 = plaintext body;
  // >=1 = body is base64(suite||nonce||ct||tag) under the channel
  // space key of that version.
  key_version?: number;
  // att-2: ids of attachments (already uploaded + finalized over HTTP) to
  // link to this message. The server validates ownership + membership and
  // stamps each row's message_id. Capped per message server-side.
  attachment_ids?: string[];
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
  last_reply_key_version?: number;
  // Phase 23d: message-suite key version. Undefined/0 = legacy
  // plaintext; >=1 = encrypted (see SendPayload.key_version).
  key_version?: number;
  // Phase 26 (governance prereq): soft-delete tombstone. deleted=true means
  // the message was deleted; body is empty and key_version is undefined, so
  // the client renders a "message deleted" placeholder and skips decryption.
  // deleted_by is the deleter's user_id; deleted_at is server unix-millis.
  deleted?: boolean;
  deleted_by?: string;
  deleted_at?: number;
  // att-2: attachments linked to this message, populated on the live push.
  // Empty for the common attachment-less message and for history fetches
  // (those backfill via GET /api/attachments). Go marshals the []byte
  // enc_meta/enc_preview as standard base64 strings.
  attachments?: AttachmentRefWire[];
}

// att-2: AttachmentRefWireBase is the shared shape of an attachment descriptor
// on the wire. The encrypted blobs arrive as standard-base64 strings (Go
// marshals []byte that way); the client decodes them only at decrypt time.
export interface AttachmentRefWireBase {
  id: string;
  byte_len: number;
  key_version: number;
  enc_meta: string; // base64
  enc_preview?: string; // base64; image kinds only
  preview_len?: number;
}

// AttachmentRefWire mirrors proto.AttachmentRef (Go) -- the descriptor carried
// on a message's live push. The heavy full ciphertext is never inlined; it is
// fetched via GET /api/attachments/{id}.
export type AttachmentRefWire = AttachmentRefWireBase;

// AttachmentListItemWire mirrors the richer attachRefJSON returned by the list
// endpoint (GET /api/attachments?channel_id=&since_hours=). It adds the
// channel + message linkage and a created_at so the client can backfill refs
// onto already-loaded history messages by message_id.
export interface AttachmentListItemWire extends AttachmentRefWireBase {
  channel_id: string;
  message_id?: string; // absent while still 'uploading' / unlinked
  created_at: number; // unix millis
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
  created_by: string;
  created_at: number; // unix-millis
  member_ids: string[];
  members?: ChannelMemberWire[]; // phase 08c; optional for backward compat
  current_key_version?: number; // phase 25; absent from older servers -> 1
  rotation_pending?: boolean; // member removal; absent from older servers -> false
  governance_mode?: string; // gov-2; "dictator" | "democratic"; absent -> "dictator"
  channel_type?: string; // 30-4; "text" | "voice"; absent from older servers -> "text"
}

export interface CreateChannelPayload {
  name: string;
  is_dm?: boolean;
  member_ids?: string[];
  // 30-4: "voice" creates a Discord-style voice room; omitted/"text" is a
  // normal text channel. Server rejects "voice" for DMs.
  channel_type?: string;
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
// Phase 26 (governance prereq: message deletion):
export const ErrCodeMessageNotFound = "message_not_found";
export const ErrCodeDeleteForbidden = "delete_forbidden";

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


// ---- Phase 26: message deletion (governance prereq) ----------------

export const TypeDeleteMessage = "delete_message";
export const TypeDeleteMessageAck = "delete_message_ack";
export const TypeMessageDeleted = "message_deleted";

// delete_message: owner-only (dictator-style) request to delete a message.
// ts is the target message's server unix-millis (the client always has it).
export interface DeleteMessagePayload {
  channel_id: string;
  message_id: string;
  ts: number;
}

export interface DeleteMessageAckPayload {
  channel_id: string;
  message_id: string;
}

// message_deleted: per-channel push telling members to tombstone the message.
export interface MessageDeletedPayload {
  channel_id: string;
  message_id: string;
  seq: number;
  deleted_by?: string;
  deleted_at?: number;
}

// ---- gov-2: governance (mode + proposal lifecycle) -----------------
//
// Wire types mirroring internal/proto/governance.go. gov-2-1 wires the client
// to receive governance_event pushes and surface the channel's mode; the
// proposals panel and the propose/vote/cancel send-paths land in gov-2-2.

export const TypeGovSetMode = "gov_set_mode";
export const TypeGovSetModeAck = "gov_set_mode_ack";
export const TypeGovPropose = "gov_propose";
export const TypeGovProposeAck = "gov_propose_ack";
export const TypeGovVote = "gov_vote";
export const TypeGovVoteAck = "gov_vote_ack";
export const TypeGovCancel = "gov_cancel";
export const TypeGovCancelAck = "gov_cancel_ack";
export const TypeGovList = "gov_list_proposals";
export const TypeGovListAck = "gov_list_proposals_ack";
export const TypeGovernanceEvent = "governance_event";

// governance_event sub-kinds (GovernanceEventPayload.kind).
export const GovEventModeChanged = "mode_changed";
export const GovEventProposalOpened = "proposal_opened";
export const GovEventProposalUpdated = "proposal_updated";
export const GovEventProposalResolved = "proposal_resolved";

export type GovernanceMode = "dictator" | "democratic";

// ProposalViewWire: counts-only tally (per-voter ballots are never shipped,
// H7). your_vote is filled for the caller in a list ack; empty in broadcast
// pushes (clients track their own vote from the vote ack).
export interface ProposalViewWire {
  id: string;
  channel_id: string;
  type: string;
  target_id?: string;
  payload?: unknown;
  created_by: string;
  created_at: string; // RFC3339
  expires_at: string; // RFC3339
  status: string;
  eligible: number;
  yes: number;
  no: number;
  voted: number;
  your_vote?: string; // "yes" | "no" | ""
}

export interface GovSetModePayload {
  channel_id: string;
  mode: string;
}
export interface GovSetModeAckPayload {
  channel_id: string;
  mode: string;
}
export interface GovProposePayload {
  channel_id: string;
  type: string;
  target_id?: string;
  payload?: unknown;
}
export interface GovProposeAckPayload {
  proposal: ProposalViewWire;
}
export interface GovVotePayload {
  proposal_id: string;
  vote: string;
}
export interface GovVoteAckPayload {
  proposal_id: string;
  vote: string;
}
export interface GovCancelPayload {
  proposal_id: string;
}
export interface GovCancelAckPayload {
  proposal_id: string;
}
export interface GovListPayload {
  channel_id: string;
  include_resolved?: boolean;
}
export interface GovListAckPayload {
  channel_id: string;
  proposals: ProposalViewWire[];
}

export interface GovernanceEventPayload {
  kind: string;
  channel_id: string;
  mode?: string;
  proposal?: ProposalViewWire;
}

// --- Phase 30 (voice, slice 30-4): TypeScript mirror of internal/proto/voice.go

// Client -> server.
export const TypeVoiceJoin = "voice_join";
export const TypeVoiceLeave = "voice_leave";
export const TypeVoiceRoster = "voice_roster";
export const TypeVoiceSignal = "voice_signal"; // doubles as the relayed push type
export const TypeVoiceState = "voice_state";

// Server -> client (acks to a ref).
export const TypeVoiceJoinAck = "voice_join_ack";
export const TypeVoiceLeaveAck = "voice_leave_ack";
export const TypeVoiceRosterAck = "voice_roster_ack";
export const TypeVoiceStateAck = "voice_state_ack";

// Server -> client (pushes, no ref).
export const TypeVoiceParticipantJoined = "voice_participant_joined";
export const TypeVoiceParticipantLeft = "voice_participant_left";
export const TypeVoiceParticipantState = "voice_participant_state";

// One roster entry: a (user, device) currently in the room + media flags.
export interface VoiceParticipantWire {
  user_id: string;
  device_id: string;
  muted: boolean;
  video_on: boolean;
  screen_on: boolean;
}

// Mirrors proto.ICEServer -- the RTCIceServer dictionary as handed to a
// joining client. username/credential are empty for STUN; for TURN they
// carry the short-lived HMAC credential minted per-join (design §5).
export interface ICEServerWire {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface VoiceJoinPayload {
  channel_id: string;
}

// Roster EXCLUDES the joiner (the joiner offers to exactly these existing
// peers -- glare-free, design §4). force_relay mirrors
// CHALK_VOICE_FORCE_RELAY (§7d: iceTransportPolicy='relay').
export interface VoiceJoinAckPayload {
  channel_id: string;
  roster: VoiceParticipantWire[];
  ice_servers: ICEServerWire[];
  force_relay?: boolean;
  // 30-8: adaptive-quality policy (design Addendum D). Absent on older
  // servers; the client then uses its baked defaults.
  adaptive?: VoiceAdaptiveWire;
}

// VoiceAdaptiveWire mirrors proto.VoiceAdaptiveConfig (30-8, the
// CHALK_VOICE_* adaptive knobs, design D5).
export interface VoiceAdaptiveWire {
  probe_enabled?: boolean;
  probe_bytes?: number;
  recheck_secs?: number[];
  uplink_headroom?: number;
  audio_kbps?: number;
  min_video_kbps?: number;
}

export interface VoiceLeavePayload {
  channel_id: string;
}

export interface VoiceLeaveAckPayload {
  channel_id: string;
  left: boolean;
}

export interface VoiceRosterPayload {
  channel_id: string;
}

export interface VoiceRosterAckPayload {
  channel_id: string;
  roster: VoiceParticipantWire[];
}

// The E2E-encrypted signaling blob (SealedSignal from voice/signal-crypto)
// rides in the payload slot; the server routes by (to_user, to_device) and
// never inspects it. kind: offer|answer|ice|screen_add|screen_remove.
export interface VoiceSignalSendPayload {
  channel_id: string;
  to_user: string;
  to_device: string;
  kind: string;
  payload: unknown;
}

// The relayed form delivered to the target device (no ref).
export interface VoiceSignalPushPayload {
  channel_id: string;
  from_user: string;
  from_device: string;
  kind: string;
  payload: unknown;
}

export interface VoiceStatePayload {
  channel_id: string;
  muted: boolean;
  video_on: boolean;
  screen_on: boolean;
}

export interface VoiceStateAckPayload {
  channel_id: string;
}

export interface VoiceParticipantJoinedPayload {
  channel_id: string;
  user_id: string;
  device_id: string;
}

export interface VoiceParticipantLeftPayload {
  channel_id: string;
  user_id: string;
  device_id: string;
}

export interface VoiceParticipantStatePayload {
  channel_id: string;
  user_id: string;
  device_id: string;
  muted: boolean;
  video_on: boolean;
  screen_on: boolean;
}

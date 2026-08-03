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
// Sent to the ORIGINATING connection once a send has committed, carrying the
// message's persisted server identity plus the client_msg_id the sender chose.
// Lets the client retire its optimistic row deterministically (the live echo is
// suppressed for the sender's own conn, and history carries no client_msg_id).
export const TypeSendAck = "send_ack";

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
  // 39-1: the build serving this session -- release tag ("v0.3.27") or
  // "0.0.0-dev", plus the short commit. Absent from older servers, in which
  // case the badge reads "dev" and links at main.
  server_version?: string;
  server_commit?: string;
  // 82-6: server policy (CHALK_WRAP_SIG_REQUIRED). When true, unsigned
  // channel-key wraps must be refused on read. Absent from older servers ->
  // the soft window stays open (the safe-for-continuity default).
  wrap_sig_required?: boolean;
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
  // Client-generated idempotency key (UUID). Echoed back by the server in
  // MessagePayload.client_msg_id so this client can match the server push
  // to its optimistic row and replace it instead of duplicating. Prevents
  // the double-render that occurs on reconnect (per-conn echo-suppression
  // misses the sender's new conn).
  client_msg_id?: string;
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
  // Phase 37-1: server unix-millis of the last in-place edit; undefined when
  // never edited. body already holds the edited ciphertext (only one version
  // is ever stored), so this exists only to render an "(edited)" marker.
  edited_at?: number;
  // Phase 42-3: OUR OWN thread read state for this row, only meaningful on a
  // thread head and only sent on history fetches (a live push has no single
  // recipient to resolve it for). A reply is unread when
  // last_reply_seq > thread_last_read_seq. thread_involved means we wrote the
  // head or one of the replies.
  //
  // These replaced the per-device localStorage thread cursors: read state now
  // arrives with the rows it decorates, so it follows the user across devices
  // and needs no bulk sync frame.
  thread_last_read_seq?: number;
  thread_involved?: boolean;
  // att-2: attachments linked to this message, populated on the live push,
  // history pages and thread fetches alike. Empty for the common
  // attachment-less message. Go marshals the []byte enc_meta/enc_preview as
  // standard base64 strings.
  attachments?: AttachmentRefWire[];
  // Echoes back SendPayload.client_msg_id on the live push of a freshly-sent
  // message, so the ORIGINATING client can match this to its optimistic row
  // and replace it (adopting server id/seq/ts). Undefined for history
  // fetches and messages from other senders.
  client_msg_id?: string;
}

// Ack returned to the sender once its send has committed. Carries the
// persisted server identity of the message so the optimistic row can be
// retired without waiting on the (suppressed) live echo or a history fetch.
export interface SendAckPayload {
  client_msg_id: string;
  id: string;
  channel_id: string;
  seq: number;
  ts: number;
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

// FriendEventPayload mirrors proto.FriendEventPayload. Kind is one of
// request_received | accepted | declined | removed.
export interface FriendEventPayload {
  kind: string;
  from_user_id: string;
  handle: string;
}

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

// 80-12: ephemeral guest invites (owner-only; docs/PHASE-80-EPHEMERAL.md).
export const TypeEphemeralInviteMint = "ephemeral_invite_mint";
export const TypeEphemeralInviteMintAck = "ephemeral_invite_mint_ack";
export const TypeEphemeralInviteList = "ephemeral_invite_list";
export const TypeEphemeralInviteListAck = "ephemeral_invite_list_ack";
export const TypeEphemeralInviteRevoke = "ephemeral_invite_revoke";
export const TypeEphemeralInviteRevokeAck = "ephemeral_invite_revoke_ack";
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
  group_name?: string; // 54-2; creator's grouping suggestion; absent -> "General"
  // 80-6: when the channel self-destructs, unix-millis. Absent -> permanent.
  expires_at?: number;
  last_seq?: number; // 33-1; highest seq in the channel; absent from older servers -> 0
  last_read_seq?: number; // 33-1; this user's read cursor; absent -> 0
  // 62-2: newest-message activity (Zuckermode). last_msg_body is ciphertext
  // the server cannot read; the client decrypts it into a preview. All
  // absent when the channel is empty or on channel_event pushes.
  last_msg_id?: string;
  last_msg_seq?: number;
  last_msg_ts?: number; // unix-millis
  last_msg_sender_user_id?: string;
  last_msg_body?: string;
  last_msg_key_version?: number;
  last_msg_deleted?: boolean;
}

export interface CreateChannelPayload {
  name: string;
  is_dm?: boolean;
  member_ids?: string[];
  // 30-4: "voice" creates a Discord-style voice room; omitted/"text" is a
  // normal text channel. Server rejects "voice" for DMs.
  channel_type?: string;
  // 54-2: roster-grouping suggestion. Omitted -> "General" server-side.
  group_name?: string;
  // 80-6: > 0 makes the channel ephemeral -- destroyed (contents and guests
  // included) this many seconds after creation. Voice-only, no DM. The
  // server clamps to its CHALK_EPHEMERAL_MAX_TTL_HOURS cap and answers with
  // the resulting absolute expires_at in the summary.
  ttl_secs?: number;
}

export interface CreateChannelAckPayload {
  channel: ChannelSummaryWire;
}

// 80-12: ephemeral guest invite payloads. All byte fields base64 (std); the
// link secret itself never appears on any of these -- the server only holds
// material that is useless without it.
export interface EphemeralInviteMintPayload {
  channel_id: string;
  lookup: string; // b64, 16 bytes
  guest_user_id: string;
  x25519_pub: string; // b64, 32 bytes
  ed25519_pub: string; // b64, 32 bytes
  self_sig: string; // b64, 64 bytes
  key_version: number;
  wrap_suite: number;
  wrap_blob: string; // b64
  label?: string;
  ttl_secs?: number; // 0/omitted = server max (capped at 24 h)
}

export interface EphemeralInviteMintAckPayload {
  channel_id: string;
  lookup: string;
  expires_at: number; // unix-millis, after clamping
}

export interface EphemeralInviteListPayload {
  channel_id: string;
}

export interface EphemeralInviteInfoWire {
  lookup: string; // b64
  guest_user_id: string;
  label?: string;
  created_at: number;
  expires_at: number;
  redeemed_at?: number;
  revoked_at?: number;
}

export interface EphemeralInviteListAckPayload {
  channel_id: string;
  invites: EphemeralInviteInfoWire[];
  max_guests: number;
}

export interface EphemeralInviteRevokePayload {
  channel_id: string;
  lookup: string;
}

export interface EphemeralInviteRevokeAckPayload {
  channel_id: string;
  lookup: string;
}

export interface ListChannelsPayload {}

export interface ListChannelsAckPayload {
  channels: ChannelSummaryWire[];
}

export interface FetchHistoryPayload {
  channel_id: string;
  before_seq?: number;
  limit?: number;
  // 55-2: exclude thread replies, so a scrollback page is `limit` rows the
  // main feed will actually show. Only the paging path sets it -- the
  // initial fetch keeps replies for the mention scan and thread warm-up.
  heads_only?: boolean;
}

export interface FetchHistoryAckPayload {
  channel_id: string;
  before_seq: number;
  messages: MessagePayload[];
}

export interface ChannelEventPayload {
  // "added" | "removed" | "member_added" | "member_removed" | "rotate_needed"
  // | "key_rotated" | "key_available". For "key_available" (38-3) the summary
  // carries only id + current_key_version.
  kind: string;
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
// Phase 37-2: edit refused -- not the sender, already deleted, or past the
// edit window. One code for all three; the client already knows the rules for
// its own messages, so it never needs to distinguish.
export const ErrCodeEditForbidden = "edit_forbidden";

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


// ---- Phase 33-1: read cursors --------------------------------------

export const TypeMarkRead = "mark_read";
export const TypeMarkReadAck = "mark_read_ack";
export const TypeReadState = "read_state";

// mark_read raises this user's read cursor for a channel. The server
// clamps seq to the channel's last assigned seq and never lets the cursor
// move backwards, so over-sending is harmless.
export interface MarkReadPayload {
  channel_id: string;
  seq: number;
}

// read_state is both the mark_read ack (carrying the effective cursor after
// clamping) and the push that lands on this user's OTHER devices.
export interface ReadStatePayload {
  channel_id: string;
  last_read_seq: number;
}

// ---- Phase 43-1: typing indicators ---------------------------------

export const TypeTyping = "typing";
export const TypeTypingUpdate = "typing_update";

// typing is fire-and-forget: no ack, nothing persisted. Re-send it every few
// seconds while composing; the server throttles anything faster and drops it
// silently. thread_id is on the wire for a future thread indicator -- the
// thread composer does not send it today.
export interface TypingPayload {
  channel_id: string;
  thread_id?: string;
}

// typing_update names one person composing in a channel. Never delivered to
// the typist's own devices. Entries age out after TYPING_TTL_MS unless another
// update refreshes them.
export interface TypingUpdatePayload {
  channel_id: string;
  thread_id?: string;
  user_id: string;
}

// ---- Phase 42-4: thread read cursors -------------------------------

export const TypeMarkThreadRead = "mark_thread_read";
export const TypeMarkThreadReadAck = "mark_thread_read_ack";
export const TypeThreadReadState = "thread_read_state";

// mark_thread_read is mark_read one level down: seq is the highest REPLY seq
// seen in this thread. Same clamping and same refusal to rewind, so
// over-sending is harmless. channel_id is carried for the membership check.
export interface MarkThreadReadPayload {
  channel_id: string;
  thread_id: string;
  seq: number;
}

// thread_read_state is both the ack and the cross-device push. This is what
// replaced the per-device localStorage thread cursors: a badge cleared on one
// device now clears on the others.
export interface ThreadReadStatePayload {
  channel_id: string;
  thread_id: string;
  last_read_seq: number;
}

// ---- Phase 42-6: the cross-channel thread inbox --------------------

export const TypeThreadInbox = "thread_inbox";
export const TypeThreadInboxAck = "thread_inbox_ack";

export interface ThreadInboxPayload {
  // Pages backwards through last_reply_ts (server unix-millis); 0 = newest.
  // A ts, not a seq: seq is per-channel and this list spans channels.
  before_ts?: number;
  limit?: number;
}

// One thread worth looking at. head_body / last_reply_body are CIPHERTEXT --
// same body + key_version pair a MessagePayload carries, decrypted client-side
// per channel. The server has read neither.
export interface ThreadInboxEntry {
  channel_id: string;
  thread_id: string;

  head_seq: number;
  head_ts: number;
  head_sender_user_id?: string;
  head_body?: string;
  head_key_version?: number;
  head_deleted?: boolean;

  last_reply_seq: number;
  last_reply_ts: number;
  last_reply_sender_user_id?: string;
  last_reply_body?: string;
  last_reply_key_version?: number;
  last_reply_deleted?: boolean;

  reply_count: number;
  last_read_seq: number;
  // We wrote the head or one of the replies. Server-computed from the sending
  // device, so it needs no plaintext -- it is the server's half of "does this
  // thread concern me". Mentions are the client's half.
  involved: boolean;
}

// Two lists, deliberately not merged: `active` is discovery (bounded by the
// recency window, paginated), `aged_unread` is the safety net (bounded by
// involvement, first page only). Merging them would let a busy user's live
// threads push a forgotten unread one off the page.
export interface ThreadInboxAckPayload {
  active: ThreadInboxEntry[];
  aged_unread?: ThreadInboxEntry[];
  // Involved threads with an unread reply at ANY age, ignoring both limits, so
  // the dot stays honest when a list is truncated.
  unread_involved_total: number;
  active_window_hours: number;
  has_more_active?: boolean;
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

// ---- Phase 37: message edits ---------------------------------------

export const TypeEditMessage = "edit_message";
export const TypeEditMessageAck = "edit_message_ack";
export const TypeMessageEdited = "message_edited";

// edit_message: sender-only request to replace a message's body, allowed
// while the message is younger than EDIT_WINDOW_MS (see chat/editpolicy.ts).
// ts locates the row in the ts-partitioned table; body/key_version are the
// re-encrypted content, validated server-side exactly like a fresh send.
export interface EditMessagePayload {
  channel_id: string;
  message_id: string;
  ts: number;
  body: string;
  key_version: number;
}

export interface EditMessageAckPayload {
  channel_id: string;
  message_id: string;
  edited_at: number;
}

// message_edited: per-channel push carrying the NEW ciphertext, so members
// swap the body in place without a re-fetch. seq is unchanged by an edit --
// the message keeps its position in history.
export interface MessageEditedPayload {
  channel_id: string;
  message_id: string;
  seq: number;
  body: string;
  key_version: number;
  edited_at: number;
}

// ---- Phase 37: reactions -------------------------------------------

export const TypeSetReactions = "set_reactions";
export const TypeSetReactionsAck = "set_reactions_ack";
export const TypeReactionUpdate = "reaction_update";
export const TypeFetchReactions = "fetch_reactions";
export const TypeFetchReactionsAck = "fetch_reactions_ack";

// set_reactions replaces the caller's WHOLE emoji set for one message -- there
// is no add/remove verb, so toggling is idempotent and two of your own devices
// can't drift. body is base64 of the sealed JSON array; an empty body clears.
export interface SetReactionsPayload {
  channel_id: string;
  message_id: string;
  ts: number;
  body: string;
  key_version?: number;
}

export interface SetReactionsAckPayload {
  channel_id: string;
  message_id: string;
}

// One member's sealed set for one message. An empty body means they cleared
// their reactions; the push still arrives so others drop them from the tally.
export interface ReactionWire {
  message_id: string;
  ts: number;
  user_id: string;
  body?: string;
  key_version?: number;
}

export interface ReactionUpdatePayload {
  channel_id: string;
  reaction: ReactionWire;
}

// History responses don't carry reactions, so the client asks once per loaded
// window rather than paying for them on every page of every channel.
export interface FetchReactionsPayload {
  channel_id: string;
  message_ids: string[];
}

export interface FetchReactionsAckPayload {
  channel_id: string;
  reactions: ReactionWire[];
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
// 45-1: the room emptied and the channel's scratchpad text was destroyed.
export const TypeVoicePurged = "voice_purged";

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

// 45-1: the last participant left, so the server destroyed everything typed
// in this voice channel. Sent to every member, in-room or not.
export interface VoicePurgedPayload {
  channel_id: string;
}

// 46-1: an unsolicited announcement about the server itself. `kind`
// discriminates so later notices need no new frame type; unknown kinds are
// ignored, the same tolerance App.tsx's `default: break` gives unknown types.
export const TypeServerNotice = "server_notice";
export const NoticeRestarting = "restarting";

export interface ServerNoticePayload {
  kind: string;
  version?: string;
  commit?: string;
}

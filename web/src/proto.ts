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
}

export interface MessagePayload {
  id: string;
  channel_id: string; // phase 08
  seq: number;        // phase 08
  sender: string;
  ts: number;
  body: string;
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

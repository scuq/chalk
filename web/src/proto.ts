// chalk wire protocol — TypeScript mirror of internal/proto/proto.go
// and internal/proto/frames_phase06.go.
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
  device_type?: string; // phone | tablet | desktop ; missing = browser-unknown
}

export interface WelcomePayload {
  user_id: string;
  device_id: string;
  channels: string[];
}

export interface SendPayload {
  body: string;
}

export interface MessagePayload {
  id: string;
  sender: string; // device_id, or "" for purged-user messages
  ts: number; // unix-millis
  body: string;
}

export interface ErrorPayload {
  code: string;
  message: string;
}

// --- Phase 06 presence + friends (declared, not exercised by phase 07)

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

// --- Error codes ----------------------------------------------------

export const ErrCodeBadFrame = "bad_frame";
export const ErrCodeBadPayload = "bad_payload";
export const ErrCodeUnknownType = "unknown_type";
export const ErrCodeNotHelloed = "not_helloed";
export const ErrCodeInternal = "internal";
export const ErrCodeRateLimited = "rate_limited";
export const ErrCodeFrameTooLarge = "frame_too_large";

// --- Helpers --------------------------------------------------------

export function newFrame<P>(type: string, payload?: P, ref?: string): Frame<P> {
  const f: Frame<P> = { type };
  if (ref) f.ref = ref;
  if (payload !== undefined) f.payload = payload;
  return f;
}

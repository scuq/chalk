// chalk -- channel space-key distribution over the WebSocket.
//
// Thin glue between crypto/spacekey.ts and the server's channel-key frames
// (handled in internal/server/ws.go, phase 23c). Built on WSClient.request().
//
//   * publishChannelKey         -- upload ONE member's wrapped space key for
//     a channel + key_version. Used when wrapping the key for ourselves (on
//     channel create / first hold) and when auto-rewrapping for members who
//     don't have it yet.
//   * fetchChannelKey           -- fetch OUR OWN wrapped key for a channel +
//     key_version (the server only ever returns the caller's wrap). Returns
//     the {suite, blob} to hand to unwrapSpaceKey, or null if no wrap exists
//     yet (we must wait for an online member to wrap it for us).
//   * fetchChannelKeyRecipients -- list the member ids that already hold a
//     wrap for (channel, key_version). The caller diffs this against the
//     channel member list to find who still needs the key.
//
// The server is a blind relay: these move opaque suite-tagged blobs; no key
// material is exposed to it. byte<->base64 is std (matches base64.StdEncoding).

import type { WrappedKey } from "./spacekey";

// Minimal shape of WSClient.request we depend on (mirrors IdentityTransport).
export interface ChannelKeyTransport {
  request<P, R = unknown>(type: string, payload?: P): Promise<R>;
}

const TYPE_PUBLISH_CHANNEL_KEY = "publish_channel_key";
const TYPE_FETCH_CHANNEL_KEY = "fetch_channel_key";
const TYPE_FETCH_CHANNEL_KEY_RECIPIENTS = "fetch_channel_key_recipients";
const TYPE_ROTATE_CHANNEL_KEY = "rotate_channel_key";
const TYPE_REMOVE_MEMBER = "remove_member";
const TYPE_ADD_MEMBER = "add_member";
const TYPE_DELETE_MESSAGE = "delete_message";

interface PublishChannelKeyPayload {
  channel_id: string;
  key_version: number;
  recipient_id: string;
  wrap_suite: number;
  blob: string; // base64 std
}
interface PublishChannelKeyAck {
  channel_id: string;
  key_version: number;
  recipient_id: string;
}
interface FetchChannelKeyPayload {
  channel_id: string;
  key_version: number;
}
interface FetchChannelKeyAck {
  found: boolean;
  channel_id: string;
  key_version?: number;
  wrap_suite?: number;
  blob?: string;
}
interface FetchChannelKeyRecipientsPayload {
  channel_id: string;
  key_version: number;
}
interface FetchChannelKeyRecipientsAck {
  channel_id: string;
  key_version: number;
  recipients: string[];
}

/**
 * publishChannelKey uploads a wrapped space key for recipientID in
 * (channelID, keyVersion). Resolves on ack; rejects if the request fails
 * (e.g. not a member, recipient not a member).
 */
export async function publishChannelKey(
  ws: ChannelKeyTransport,
  channelID: string,
  keyVersion: number,
  recipientID: string,
  wrap: WrappedKey,
): Promise<void> {
  const payload: PublishChannelKeyPayload = {
    channel_id: channelID,
    key_version: keyVersion,
    recipient_id: recipientID,
    wrap_suite: wrap.suite,
    blob: bytesToBase64(wrap.blob),
  };
  await ws.request<PublishChannelKeyPayload, PublishChannelKeyAck>(TYPE_PUBLISH_CHANNEL_KEY, payload);
}

/**
 * fetchChannelKey returns OUR wrapped key for (channelID, keyVersion) as a
 * WrappedKey ready for unwrapSpaceKey, or null if none exists yet (waiting
 * for access) or the response is malformed.
 */
export async function fetchChannelKey(
  ws: ChannelKeyTransport,
  channelID: string,
  keyVersion: number,
): Promise<WrappedKey | null> {
  const ack = await ws.request<FetchChannelKeyPayload, FetchChannelKeyAck>(TYPE_FETCH_CHANNEL_KEY, {
    channel_id: channelID,
    key_version: keyVersion,
  });
  if (!ack.found || !ack.blob || typeof ack.wrap_suite !== "number") return null;
  let blob: Uint8Array;
  try {
    blob = base64ToBytes(ack.blob);
  } catch {
    return null;
  }
  if (blob.length === 0) return null;
  return { suite: ack.wrap_suite, blob };
}

/**
 * fetchChannelKeyRecipients returns the member ids that already hold a wrap
 * for (channelID, keyVersion). Empty array if none / on a missing field.
 */
export async function fetchChannelKeyRecipients(
  ws: ChannelKeyTransport,
  channelID: string,
  keyVersion: number,
): Promise<string[]> {
  const ack = await ws.request<FetchChannelKeyRecipientsPayload, FetchChannelKeyRecipientsAck>(
    TYPE_FETCH_CHANNEL_KEY_RECIPIENTS,
    { channel_id: channelID, key_version: keyVersion },
  );
  return Array.isArray(ack.recipients) ? ack.recipients : [];
}

// ---- base64 (standard, with padding -- matches Go's base64.StdEncoding) ----

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface RotateChannelKeyPayload {
  channel_id: string;
  new_version: number;
}
interface RotateChannelKeyAck {
  channel_id: string;
  current_key_version: number;
}

/**
 * commitRotation asks the server to advance a channel's current key version to
 * newVersion (phase 25). Call this AFTER the new-version wraps have been
 * uploaded via publishChannelKey (ChannelCrypto.rotateChannelKey does that).
 * Resolves with the server's confirmed current version; rejects if the caller
 * isn't the creator or newVersion isn't current+1.
 */
export async function commitRotation(
  ws: ChannelKeyTransport,
  channelID: string,
  newVersion: number,
): Promise<number> {
  const ack = await ws.request<RotateChannelKeyPayload, RotateChannelKeyAck>(
    TYPE_ROTATE_CHANNEL_KEY,
    { channel_id: channelID, new_version: newVersion },
  );
  return ack.current_key_version;
}

interface RemoveMemberPayload {
  channel_id: string;
  target_id: string;
}
interface RemoveMemberAck {
  channel_id: string;
  target_id: string;
}

/**
 * removeMember asks the server to remove targetID from a channel (member
 * removal + rotate-on-removal). Authz is server-enforced: the owner may remove
 * any non-owner; a non-owner may remove only themselves (leave). Resolves on
 * ack; rejects with the server's error (e.g. remove_forbidden, dm_no_removal).
 * The server flags the channel rotation_pending and prompts the owner to rotate.
 */
export async function removeMember(
  ws: ChannelKeyTransport,
  channelID: string,
  targetID: string,
): Promise<void> {
  await ws.request<RemoveMemberPayload, RemoveMemberAck>(TYPE_REMOVE_MEMBER, {
    channel_id: channelID,
    target_id: targetID,
  });
}

interface AddMemberPayload {
  channel_id: string;
  target_id: string;
}
interface AddMemberAck {
  channel_id: string;
  target_id: string;
}

/**
 * addMember asks the server to add targetID to a channel (add-member). Any
 * member may add (invite); the target must be a real user. Resolves on ack;
 * rejects with the server's error (e.g. already_member, dm_no_add). The new
 * member gets the CURRENT key via a key holder's reshare (forward-only access).
 */
export async function addMember(
  ws: ChannelKeyTransport,
  channelID: string,
  targetID: string,
): Promise<void> {
  await ws.request<AddMemberPayload, AddMemberAck>(TYPE_ADD_MEMBER, {
    channel_id: channelID,
    target_id: targetID,
  });
}

interface DeleteMessagePayload {
  channel_id: string;
  message_id: string;
  ts: number;
}
interface DeleteMessageAck {
  channel_id: string;
  message_id: string;
}

/**
 * deleteMessage asks the server to delete a message (governance prereq).
 * Authz is server-enforced and dictator-style: ONLY the channel owner may
 * delete. ts is the target message's server unix-millis. Resolves on ack
 * (including the idempotent re-delete case); rejects with the server's error
 * (e.g. delete_forbidden, message_not_found). The server scrubs the body and
 * pushes message_deleted to every member so clients tombstone the row.
 */
export async function deleteMessage(
  ws: ChannelKeyTransport,
  channelID: string,
  messageID: string,
  ts: number,
): Promise<void> {
  await ws.request<DeleteMessagePayload, DeleteMessageAck>(TYPE_DELETE_MESSAGE, {
    channel_id: channelID,
    message_id: messageID,
    ts,
  });
}

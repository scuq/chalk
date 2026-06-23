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

// chalk -- identity publish/fetch over the WebSocket.
//
// Thin glue between crypto/identity.ts and the server's publish_identity /
// fetch_identity frames (handled in internal/server/ws.go). Built on
// WSClient.request(), which sends a ref-tagged frame and resolves with the
// ack payload (or rejects on an error frame).
//
//   * publishIdentity -- upload OUR public identity after deriving it from
//     the phrase. The server validates lengths and stores it; it does not
//     verify the self-signature (the server is untrusted).
//   * fetchIdentity   -- look up another user's identity AND verify the
//     self-signature locally before returning it. This is the security-
//     critical step: a malicious server cannot substitute the X25519 key
//     because it cannot forge the Ed25519 self-signature over it. A fetch
//     whose self-sig fails verification is treated as "not found / not
//     trustworthy" -- callers never receive unverified keys.
//
// The byte<->base64 helpers and the verify-on-fetch logic are pure and
// unit-tested; only the .request() call needs a live socket.

import { verifyIdentitySelfSig, type DerivedIdentity } from "./identity";

// Minimal shape of WSClient.request we depend on -- avoids a hard import
// cycle and keeps this unit testable with a fake.
export interface IdentityTransport {
  request<P, R = unknown>(type: string, payload?: P): Promise<R>;
}

const TYPE_PUBLISH_IDENTITY = "publish_identity";
const TYPE_FETCH_IDENTITY = "fetch_identity";

interface PublishIdentityPayload {
  generation: number;
  x25519_pub: string;
  ed25519_pub: string;
  self_sig: string;
}
interface PublishIdentityAck {
  generation: number;
}
interface FetchIdentityPayload {
  user_id: string;
}
interface FetchIdentityAck {
  found: boolean;
  user_id: string;
  generation?: number;
  x25519_pub?: string;
  ed25519_pub?: string;
  self_sig?: string;
}

/** A peer's verified identity (self-signature already checked). */
export interface PeerIdentity {
  userID: string;
  generation: number;
  x25519Public: Uint8Array;
  ed25519Public: Uint8Array;
}

/**
 * publishIdentity uploads our own public identity. Resolves with the
 * generation the server stored; rejects if the request fails.
 */
export async function publishIdentity(
  ws: IdentityTransport,
  identity: DerivedIdentity,
): Promise<number> {
  const payload: PublishIdentityPayload = {
    generation: identity.generation,
    x25519_pub: bytesToBase64(identity.x25519Public),
    ed25519_pub: bytesToBase64(identity.ed25519Public),
    self_sig: bytesToBase64(identity.selfSig),
  };
  const ack = await ws.request<PublishIdentityPayload, PublishIdentityAck>(
    TYPE_PUBLISH_IDENTITY,
    payload,
  );
  return ack.generation;
}

/**
 * fetchIdentity looks up userID's current identity and verifies its self-
 * signature. Returns the verified PeerIdentity, or null if the user has no
 * identity yet OR the returned keys fail verification (malformed, or a
 * server substitution attempt). Callers MUST treat null as "cannot use
 * this peer's keys" -- never fall back to unverified material.
 */
export async function fetchIdentity(
  ws: IdentityTransport,
  userID: string,
): Promise<PeerIdentity | null> {
  const ack = await ws.request<FetchIdentityPayload, FetchIdentityAck>(
    TYPE_FETCH_IDENTITY,
    { user_id: userID },
  );
  if (!ack.found || !ack.x25519_pub || !ack.ed25519_pub || !ack.self_sig) {
    return null;
  }
  let x25519Public: Uint8Array;
  let ed25519Public: Uint8Array;
  let selfSig: Uint8Array;
  try {
    x25519Public = base64ToBytes(ack.x25519_pub);
    ed25519Public = base64ToBytes(ack.ed25519_pub);
    selfSig = base64ToBytes(ack.self_sig);
  } catch {
    return null;
  }
  const ok = await verifyIdentitySelfSig(x25519Public, ed25519Public, selfSig);
  if (!ok) {
    return null;
  }
  return {
    userID: ack.user_id,
    generation: ack.generation ?? 1,
    x25519Public,
    ed25519Public,
  };
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

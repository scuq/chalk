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
// 83-4: the generation chain -- verified client-side, never trusted as rows.
import {
  mintGenerationCert,
  verifyGenerationChain,
  type GenerationRecord,
  type VerifiedGeneration,
} from "./idgen";

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
  gen_cert?: string; // 83-4: required by the server for generation >= 2
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
  genCert?: Uint8Array,
): Promise<number> {
  const payload: PublishIdentityPayload = {
    generation: identity.generation,
    x25519_pub: bytesToBase64(identity.x25519Public),
    ed25519_pub: bytesToBase64(identity.ed25519Public),
    self_sig: bytesToBase64(identity.selfSig),
  };
  if (genCert) payload.gen_cert = bytesToBase64(genCert);
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
 *
 * 82-2: BE CLEAR ABOUT WHAT THE SELF-SIGNATURE PROVES. It proves the X25519 and
 * Ed25519 keys in this blob belong together. It does NOT prove they are the
 * peer's: nothing signs the user id, so anyone -- including the server -- can
 * mint a consistent identity and claim it is Bob's. Callers that need the
 * ownership question answered must go through trust.ts, which anchors it on a
 * pin or an out-of-band comparison. This function is a decoder, not an oracle.
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
    // 82-2: the id we ASKED for, not ack.user_id. The echo is server-controlled
    // and nothing signs it, so trusting it let a caller believe it had resolved
    // Bob when it had resolved whatever the server felt like returning.
    userID,
    generation: ack.generation ?? 1,
    x25519Public,
    ed25519Public,
  };
}

// ---- 83-4: the generation chain ------------------------------------------

const TYPE_FETCH_IDENTITY_CHAIN = "fetch_identity_chain";

interface FetchIdentityChainAck {
  found: boolean;
  user_id: string;
  generations?: Array<{
    generation: number;
    x25519_pub: string;
    ed25519_pub: string;
    self_sig: string;
    gen_cert?: string;
    retired_at?: number;
  }>;
}

/**
 * fetchIdentityChain returns every generation the server holds for a user,
 * decoded but NOT yet verified -- feed it to idgen.verifyGenerationChain.
 * Null when the user has published nothing or a row is undecodable (a
 * malformed row is treated as the chain ending there: the verified prefix
 * decides, not the server's list).
 */
export async function fetchIdentityChain(
  ws: IdentityTransport,
  userID: string,
): Promise<GenerationRecord[] | null> {
  const ack = await ws.request<{ user_id: string }, FetchIdentityChainAck>(TYPE_FETCH_IDENTITY_CHAIN, {
    user_id: userID,
  });
  if (!ack.found || !ack.generations?.length) return null;
  const out: GenerationRecord[] = [];
  for (const g of ack.generations) {
    try {
      out.push({
        generation: g.generation,
        x25519Public: base64ToBytes(g.x25519_pub),
        ed25519Public: base64ToBytes(g.ed25519_pub),
        selfSig: base64ToBytes(g.self_sig),
        genCert: g.gen_cert ? base64ToBytes(g.gen_cert) : null,
      });
    } catch {
      break; // undecodable row: the chain ends here for us
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * fetchVerifiedChain fetches and walks a user's chain, returning the
 * verified prefix (possibly empty). The convenience most callers want.
 */
export async function fetchVerifiedChain(ws: IdentityTransport, userID: string): Promise<VerifiedGeneration[]> {
  const records = await fetchIdentityChain(ws, userID);
  if (!records) return [];
  return verifyGenerationChain(userID, records);
}

/**
 * publishRotatedIdentity performs a NORMAL rotation: with the retiring
 * generation's signing key in hand, mint the chalk-idgen.v1 cert admitting
 * `next` and publish it -- the server retires the old generation and
 * inserts the new one atomically. `prev` must be the CURRENT head of our
 * own verified chain (fetchVerifiedChain on our own id), so the cert links
 * to the right hash and the server's sequence check passes.
 *
 * This is the primitive, not the user flow: the phrase-rotation UI (new 24
 * words, re-wrap every channel key to the new X25519 key, re-wrap the
 * identity seed for auth) is separate work. Nothing calls this in
 * production yet; it exists so the chain has a producer and a test.
 */
export async function publishRotatedIdentity(
  ws: IdentityTransport,
  userID: string,
  prevEd25519Private: CryptoKey,
  prev: VerifiedGeneration,
  next: DerivedIdentity,
): Promise<number> {
  if (next.generation !== prev.generation + 1) {
    throw new Error(`identity-sync: rotation must be to generation ${prev.generation + 1}, got ${next.generation}`);
  }
  const cert = await mintGenerationCert(
    prevEd25519Private,
    userID,
    next.generation,
    next.ed25519Public,
    next.x25519Public,
    prev.hash,
  );
  return publishIdentity(ws, next, cert);
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

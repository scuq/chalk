// 80-17: the read side of a sealed body for a guest. Members seal signed
// envelopes (83-3), and the guest parses and classifies them as members do.
// One difference: the guest has no pin store, so it trusts the identity that
// the server returns for a sender for this session only.

import {
  parseEnvelope,
  classifyEnvelope,
  ed25519Fingerprint,
  OBJ_MESSAGE,
  type OuterFrame,
  type SignerResolution,
  type VerifyStatus,
} from "./envelope";
import { fetchIdentity, type IdentityTransport } from "./identity-sync";
import { PLACEHOLDER_FAILED } from "./channel-crypto";

/** What a guest renders for one message: the text and its verdict. */
export interface OpenedGuestBody {
  text: string;
  verify: VerifyStatus;
}

/** The trust answer that classifyEnvelope asks for, for one (actor, fingerprint) pair. */
export type GuestSignerResolve = (actorUserID: string, senderEd25519Fp: Uint8Array) => Promise<SignerResolution>;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * guestSignerResolver returns a resolver that answers with the current
 * identity key of the sender. It fetches the key once for each sender over
 * the guest socket and holds it for the session. If the sender has no
 * identity, the answer is unpinned. If a fingerprint is not the current key,
 * the answer is foreign. The guest cannot walk generation chains, so an
 * earlier generation also gets foreign.
 */
export function guestSignerResolver(ws: IdentityTransport): GuestSignerResolve {
  const keys = new Map<string, Promise<Uint8Array | null>>();
  return async (actorUserID, fp) => {
    let pending = keys.get(actorUserID);
    if (!pending) {
      pending = fetchIdentity(ws, actorUserID)
        .then((id) => id?.ed25519Public ?? null)
        .catch(() => null);
      keys.set(actorUserID, pending);
    }
    const pub = await pending;
    if (!pub) {
      keys.delete(actorUserID); // let the next message try again
      return { kind: "unpinned" };
    }
    const have = await ed25519Fingerprint(pub);
    return sameBytes(have, fp) ? { kind: "current", ed25519Public: pub } : { kind: "foreign" };
  };
}

/**
 * openGuestBody turns decrypted body plaintext into display text and a
 * verdict. A legacy body (the guest's own sends) is bare text. A malformed
 * envelope, or one that is not a message, gives the placeholder and never its
 * bytes. A message envelope gives its body text under the classified verdict.
 * The label is the boundary, and the content always shows (83-2).
 */
export async function openGuestBody(
  plaintext: Uint8Array,
  outer: OuterFrame,
  resolve: GuestSignerResolve,
): Promise<OpenedGuestBody> {
  const parsed = parseEnvelope(plaintext);
  if (parsed.kind === "legacy") {
    return { text: new TextDecoder().decode(plaintext), verify: "unsigned" };
  }
  if (parsed.kind === "malformed") {
    return { text: PLACEHOLDER_FAILED, verify: "unsigned" };
  }
  const env = parsed.env;
  if (env.objType !== OBJ_MESSAGE) {
    return { text: PLACEHOLDER_FAILED, verify: "unsigned" };
  }
  const cls = await classifyEnvelope(parsed, outer, resolve);
  return { text: env.bodyText, verify: cls.status };
}

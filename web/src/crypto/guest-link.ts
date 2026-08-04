// chalk -- guest magic-link derivation (80-12, docs/phases/PHASE-80-EPHEMERAL.md).
//
// A magic link is  https://host/join/<lookup-hex>#<secret-b64url>  and the
// SECRET IS THE WHOLE IDENTITY: everything else is derived from it, by the
// creator at mint time and by the guest at join time, independently:
//
//   lookup  = SHA-256("chalk/join-lookup" || secret)[:16]   (the URL path;
//             holding it without the secret is useless, so invite existence
//             is unobservable)
//   seed    = HKDF-SHA256(secret, salt, "chalk/guest-identity") -> 64 bytes
//   keys    = deriveIdentity(seed)          (the same X25519/Ed25519
//             derivation real users get from their BIP-39 seed)
//
// This is what defeats key substitution without out-of-band pinning: the
// creator never ASKS what the guest's key is -- it COMPUTED it, and sealed
// the space key to it with the reserved guest user id in the AAD. A key the
// creator did not derive is a wrap that does not open.
//
// The fragment never reaches the server; the join screen (80-13) strips it
// from history immediately. The derivation constants here are a WIRE CONTRACT
// between mint and join -- changing any of them orphans every outstanding link.
//
// 82-7: the fragment carries a SECOND value, the owner's Ed25519 public key:
//
//   #<base64url( secret(32) || ownerEd25519Pub(32) )>
//
// This is the guest's trust anchor. The parked wrap is now SIGNED by the
// owner, and the guest verifies it against this key -- which travelled in the
// fragment, out of the server's hands, so the server cannot substitute either
// the key or the wrap. The two lengths (32 = pre-82-7, 64 = current) are how
// old links stay redeemable: extension, not replacement, is what keeps the
// wire contract unbroken.

import { deriveIdentity, type DerivedIdentity } from "./identity";
import {
  unwrapSpaceKey,
  unwrapSpaceKeySigned,
  WRAP_SUITE_X25519_AESGCM,
  WRAP_SUITE_X25519_AESGCM_ED25519,
  type WrappedKey,
  type WrapSlot,
} from "./spacekey";

const LOOKUP_PREFIX = utf8("chalk/join-lookup");
const IDENTITY_HKDF_SALT = utf8("chalk-guest-hkdf-salt-v1");
const IDENTITY_HKDF_INFO = utf8("chalk/guest-identity");

export const GUEST_SECRET_BYTES = 32;
export const GUEST_LOOKUP_BYTES = 16;
const OWNER_ED25519_PUB_BYTES = 32;

/** Everything derived from one link secret. */
export interface GuestLinkMaterial {
  /** The 32-byte link secret; lives only in the URL fragment. */
  secret: Uint8Array;
  /** 16-byte lookup, hex-encoded (32 chars): the /join/<lookup> path part. */
  lookupHex: string;
  /** The guest's deterministic identity (same shape as a real user's). */
  identity: DerivedIdentity;
}

/**
 * deriveGuestLink computes lookup + identity from a secret. Both ends of the
 * wire call this: the creator on a fresh random secret at mint, the guest on
 * the fragment at join. Deterministic by construction.
 */
export async function deriveGuestLink(secret: Uint8Array): Promise<GuestLinkMaterial> {
  if (secret.length !== GUEST_SECRET_BYTES) {
    throw new Error(`guest-link: secret must be ${GUEST_SECRET_BYTES} bytes, got ${secret.length}`);
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", concat(LOOKUP_PREFIX, secret)),
  );
  const lookupHex = bytesToHex(digest.subarray(0, GUEST_LOOKUP_BYTES));

  const key = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveBits"]);
  const seed = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: IDENTITY_HKDF_SALT, info: IDENTITY_HKDF_INFO },
      key,
      512, // deriveIdentity wants the 64-byte BIP-39 seed shape
    ),
  );
  try {
    const identity = await deriveIdentity(seed);
    return { secret, lookupHex, identity };
  } finally {
    seed.fill(0);
  }
}

/** mintGuestLink generates a fresh secret and derives its material. */
export async function mintGuestLink(): Promise<GuestLinkMaterial> {
  const secret = new Uint8Array(GUEST_SECRET_BYTES);
  crypto.getRandomValues(secret);
  return deriveGuestLink(secret);
}

/**
 * buildJoinURL assembles the link. Both values ride ONLY in the fragment,
 * which browsers never send to the server:
 *
 *   secret            -- the whole guest identity (above)
 *   ownerEd25519Pub   -- 82-7, the key the guest verifies the wrap under
 *
 * Passing the owner key is mandatory. Making it optional would leave a
 * silently-weaker link a `?.` away, and the mint site is the one place that
 * always has the key to hand.
 */
export function buildJoinURL(origin: string, m: GuestLinkMaterial, ownerEd25519Pub: Uint8Array): string {
  if (ownerEd25519Pub.length !== OWNER_ED25519_PUB_BYTES) {
    throw new Error(`guest-link: owner ed25519 key must be ${OWNER_ED25519_PUB_BYTES} bytes`);
  }
  return `${origin}/join/${m.lookupHex}#${bytesToBase64url(concat(m.secret, ownerEd25519Pub))}`;
}

/**
 * GuestFragment is what a join link's #fragment carries.
 *
 * `ownerEd25519Pub` is null for a PRE-82-7 link (32-byte fragment). That is a
 * meaningful distinction, not a missing field: it says the link was minted
 * under the old contract, and openGuestWrap uses it to decide what the parked
 * wrap is allowed to be.
 */
export interface GuestFragment {
  secret: Uint8Array;
  ownerEd25519Pub: Uint8Array | null;
}

/**
 * parseJoinFragment decodes a location.hash. Accepts a leading '#'. Returns
 * null on anything malformed -- the join screen shows "broken link", never
 * throws. Only the two defined lengths are accepted; a fragment of any other
 * size is refused rather than truncated to a shape that happens to parse.
 */
export function parseJoinFragment(fragment: string): GuestFragment | null {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (!raw) return null;
  try {
    const bytes = base64urlToBytes(raw);
    if (bytes.length === GUEST_SECRET_BYTES) {
      return { secret: bytes, ownerEd25519Pub: null };
    }
    if (bytes.length === GUEST_SECRET_BYTES + OWNER_ED25519_PUB_BYTES) {
      return {
        secret: bytes.subarray(0, GUEST_SECRET_BYTES),
        ownerEd25519Pub: bytes.subarray(GUEST_SECRET_BYTES),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * openGuestWrap is the guest's whole trust decision, in one place (82-7).
 *
 * THE RULE: the FRAGMENT decides what the wrap must be.
 *
 *   fragment carries an owner key  ->  the wrap MUST be signed, by that key,
 *                                      as `ownerUserID`
 *   fragment carries none (legacy) ->  the wrap must be unsigned suite 1
 *
 * The fragment is the one part of the link the server never sees, so it is the
 * only thing here with any authority. Deriving the requirement from it means a
 * server cannot strip the signature off a current link (the guest expects one),
 * nor bolt a signature onto a legacy link to look trustworthy (the guest has
 * nothing to check it against and refuses instead of guessing).
 *
 * `ownerUserID` comes from the redeem response, i.e. from the server -- but it
 * is bound INSIDE the signed message, so a server that mislabels the owner
 * produces a verification failure rather than an acceptance. The key is what
 * had to travel out of band, and it did.
 *
 * Total by construction: returns null on every refusal, never throws. This runs
 * on attacker-supplied input.
 */
export async function openGuestWrap(
  wrap: WrappedKey,
  guestX25519Private: CryptoKey,
  slot: WrapSlot,
  ownerUserID: string,
  ownerEd25519Pub: Uint8Array | null,
): Promise<Uint8Array | null> {
  try {
    // The rule, in one line. Restating it here rather than leaning on the
    // primitives is deliberate: each of unwrapSpaceKey / unwrapSpaceKeySigned
    // already refuses the other's suite, so this is belt-and-braces -- but it
    // is the only place the POLICY is legible, and it holds if a primitive is
    // ever relaxed. Mutation-tested and documented as such; the teeth are in
    // the branch below, not in this line.
    const requiredSuite = ownerEd25519Pub
      ? WRAP_SUITE_X25519_AESGCM_ED25519
      : WRAP_SUITE_X25519_AESGCM;
    if (wrap.suite !== requiredSuite) return null;

    if (!ownerEd25519Pub) {
      // Anchorless (pre-82-7) link: nothing to verify against, so the old
      // unsigned path is all that is on offer -- and all that is accepted.
      return await unwrapSpaceKey(
        wrap,
        guestX25519Private,
        slot.channelID,
        slot.keyVersion,
        slot.recipientID,
      );
    }
    if (!ownerUserID) return null; // no id to bind the signature to
    return await unwrapSpaceKeySigned(wrap, guestX25519Private, slot, ownerUserID, ownerEd25519Pub);
  } catch {
    return null;
  }
}

// ---- byte helpers (local; identity.ts keeps its own private) -------------

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

/** hexToBytes decodes the lookup's hex form back to bytes (mint payload). */
export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** bytesToBase64 is the STANDARD-alphabet encoder the wire fields use. */
export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function bytesToBase64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// chalk -- guest magic-link derivation (80-12, docs/PHASE-80-EPHEMERAL.md).
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
// The fragment (#secret) never reaches the server; the join screen (80-13)
// strips it from history immediately. The derivation constants here are a
// WIRE CONTRACT between mint and join -- changing any of them orphans every
// outstanding link.

import { deriveIdentity, type DerivedIdentity } from "./identity";

const LOOKUP_PREFIX = utf8("chalk/join-lookup");
const IDENTITY_HKDF_SALT = utf8("chalk-guest-hkdf-salt-v1");
const IDENTITY_HKDF_INFO = utf8("chalk/guest-identity");

export const GUEST_SECRET_BYTES = 32;
export const GUEST_LOOKUP_BYTES = 16;

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
 * buildJoinURL assembles the link. The secret rides ONLY in the fragment,
 * which browsers never send to the server.
 */
export function buildJoinURL(origin: string, m: GuestLinkMaterial): string {
  return `${origin}/join/${m.lookupHex}#${bytesToBase64url(m.secret)}`;
}

/**
 * parseJoinFragment decodes a location.hash back into the secret. Accepts a
 * leading '#'. Returns null on anything malformed -- the join screen shows
 * "broken link", never throws.
 */
export function parseJoinFragment(fragment: string): Uint8Array | null {
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  if (!raw) return null;
  try {
    const secret = base64urlToBytes(raw);
    return secret.length === GUEST_SECRET_BYTES ? secret : null;
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

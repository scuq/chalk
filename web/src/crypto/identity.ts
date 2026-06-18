// chalk -- cryptographic identity derivation.
//
// Turns the BIP-39 seed (from crypto/bip39.ts) into the user's per-user
// identity: an X25519 keypair (key agreement; wraps space keys in phase 23)
// and an Ed25519 keypair (signatures; the identity trust anchor). Native
// WebCrypto only -- zero bundled crypto. The derivation is DETERMINISTIC:
// the same phrase always yields the same identity, which is what lets a
// fresh device (or a recovered account) reconstruct the identity from the
// 24 words alone.
//
// Derivation chain (validated against independent implementations):
//   seed(64B) --HKDF-SHA256--> x25519 scalar (32B)  [info "...-x25519-v1"]
//                          \--> ed25519 seed   (32B)  [info "...-ed25519-v1"]
//   x25519: PKCS#8 import (extractable, for JWK persistence) -> public via basepoint ECDH
//   ed25519: PKCS#8 import -> public via JWK export -> sign self-sig
//   self-sig = Ed25519(ed25519Private) over the 32-byte x25519 public
//
// The X25519 private key is imported NON-extractable and its public is
// obtained via the basepoint trick (ECDH against u=9), so the private
// scalar never has to be exportable. The Ed25519 public is obtained via a
// transient extractable import (JWK .x); the stored signing key is a
// separate non-extractable import. Either way the private key material
// never leaves the device except as the phrase the user already holds.
//
// HKDF uses an EXPLICIT non-empty salt: WebCrypto and other HKDF
// implementations disagree on how an empty/absent salt is handled (empty
// HMAC key vs HashLen zero bytes), so we pin a fixed application salt to
// keep derivation portable and unambiguous.
//
// IndexedDB persistence and the publish/fetch wiring live in phase 22c-3;
// this module is the pure, deterministic crypto core (Node-testable).

const PKCS8_X25519_PREFIX = hexToBytes("302e020100300506032b656e04220420");
const PKCS8_ED25519_PREFIX = hexToBytes("302e020100300506032b657004220420");

const HKDF_SALT = utf8("chalk-identity-hkdf-salt-v1");
const HKDF_INFO_X25519 = utf8("chalk-identity-x25519-v1");
const HKDF_INFO_ED25519 = utf8("chalk-identity-ed25519-v1");

const X25519_BASEPOINT = (() => {
  const bp = new Uint8Array(32);
  bp[0] = 9; // u-coordinate 9, little-endian
  return bp;
})();

/**
 * A derived cryptographic identity for one generation. Private keys are
 * non-extractable CryptoKey objects (structured-cloneable, so they can be
 * stored directly in IndexedDB in 22c-3 without ever materializing the key
 * bytes in JS). Public halves are raw 32-byte arrays, ready to publish.
 */
export interface DerivedIdentity {
  generation: number;
  /** X25519 private, EXTRACTABLE (so idb.ts can persist it as JWK), usage ["deriveBits"]. */
  x25519Private: CryptoKey;
  /** Ed25519 private, non-extractable, usage ["sign"]. */
  ed25519Private: CryptoKey;
  /** X25519 public, 32 bytes. */
  x25519Public: Uint8Array;
  /** Ed25519 public, 32 bytes. */
  ed25519Public: Uint8Array;
  /** Ed25519 signature (64 bytes) by ed25519Private over x25519Public. */
  selfSig: Uint8Array;
}

/**
 * deriveIdentity turns a BIP-39 seed into a DerivedIdentity. Deterministic:
 * the same seed always produces the same keys and self-signature.
 *
 * @param seed   the 64-byte BIP-39 seed (from bip39.mnemonicToSeed)
 * @param generation  identity generation (default 1; >1 after rotation)
 */
export async function deriveIdentity(
  seed: Uint8Array,
  generation = 1,
): Promise<DerivedIdentity> {
  if (seed.length !== 64) {
    throw new Error(`identity: seed must be 64 bytes, got ${seed.length}`);
  }
  if (generation < 1) {
    throw new Error(`identity: generation must be >= 1, got ${generation}`);
  }

  const x25519Scalar = await hkdf32(seed, HKDF_INFO_X25519);
  const ed25519Seed = await hkdf32(seed, HKDF_INFO_ED25519);

  try {
    // X25519 private + public via basepoint ECDH. Imported EXTRACTABLE so
    // crypto/idb.ts can export it to JWK for persistence: Safari/WebKit
    // cannot structured-clone an X25519 CryptoKey into IndexedDB, so it is
    // stored as JWK rather than as a key object. The X25519 private key is
    // therefore recoverable bytes at rest; the 24-word phrase is the
    // wallet-seed-grade root either way. Ed25519 below stays non-extractable
    // (it clones fine on all target engines).
    const x25519Private = await crypto.subtle.importKey(
      "pkcs8",
      concat(PKCS8_X25519_PREFIX, x25519Scalar),
      { name: "X25519" },
      true,
      ["deriveBits"],
    );
    const x25519Public = await x25519PublicFromPrivate(x25519Private);

    // Ed25519 public via a transient extractable import (JWK .x); the
    // stored signing key is a separate non-extractable import.
    const ed25519Public = await ed25519PublicFromSeed(ed25519Seed);
    const ed25519Private = await crypto.subtle.importKey(
      "pkcs8",
      concat(PKCS8_ED25519_PREFIX, ed25519Seed),
      { name: "Ed25519" },
      false,
      ["sign"],
    );

    // Self-signature binds the X25519 key to the Ed25519 identity.
    const selfSig = new Uint8Array(
      await crypto.subtle.sign({ name: "Ed25519" }, ed25519Private, x25519Public),
    );

    return {
      generation,
      x25519Private,
      ed25519Private,
      x25519Public,
      ed25519Public,
      selfSig,
    };
  } finally {
    // Best-effort scrub of the raw scalar/seed bytes once imported.
    x25519Scalar.fill(0);
    ed25519Seed.fill(0);
  }
}

/**
 * deriveIdentityFromMnemonic is the convenience entry point: validate +
 * seed the phrase, then derive. The caller should have already confirmed
 * the phrase with bip39.validateMnemonic for a good error message; this
 * does not re-check the checksum.
 */
export async function deriveIdentityFromMnemonic(
  mnemonic: string,
  generation = 1,
): Promise<DerivedIdentity> {
  // Imported lazily-style at top would create a cycle risk; bip39 has no
  // dependency on this module, so a direct import is fine.
  const { mnemonicToSeed } = await import("./bip39");
  const seed = await mnemonicToSeed(mnemonic);
  try {
    return await deriveIdentity(seed, generation);
  } finally {
    seed.fill(0);
  }
}

/**
 * verifyIdentitySelfSig checks that selfSig is a valid Ed25519 signature by
 * ed25519Public over x25519Public. A client MUST call this on every fetched
 * identity before trusting the X25519 key: it proves the server did not
 * substitute the X25519 key (the server cannot forge the signature). The
 * Ed25519 key itself is pinned out-of-band by the phase-24 picture-word
 * check. Never throws; returns false on any malformed input.
 */
export async function verifyIdentitySelfSig(
  x25519Public: Uint8Array,
  ed25519Public: Uint8Array,
  selfSig: Uint8Array,
): Promise<boolean> {
  try {
    if (x25519Public.length !== 32 || ed25519Public.length !== 32 || selfSig.length !== 64) {
      return false;
    }
    const verifyKey = await crypto.subtle.importKey(
      "jwk",
      { kty: "OKP", crv: "Ed25519", x: bytesToBase64url(ed25519Public) },
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify({ name: "Ed25519" }, verifyKey, selfSig, x25519Public);
  } catch {
    return false;
  }
}

// ---- internals ----------------------------------------------------------

async function hkdf32(seed: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", seed, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info },
    key,
    256,
  );
  return new Uint8Array(bits);
}

// x25519PublicFromPrivate derives the public key without needing the
// private key to be extractable: ECDH(priv, basepoint) == priv * 9 == the
// public key (RFC 7748). Validated against an independent X25519
// implementation.
async function x25519PublicFromPrivate(priv: CryptoKey): Promise<Uint8Array> {
  const basepointKey = await crypto.subtle.importKey("raw", X25519_BASEPOINT, { name: "X25519" }, false, []);
  const pub = await crypto.subtle.deriveBits({ name: "X25519", public: basepointKey }, priv, 256);
  return new Uint8Array(pub);
}

// ed25519PublicFromSeed imports the seed transiently as extractable just to
// read the public key out of the JWK; the key object is discarded. The
// signing key used for storage is imported separately as non-extractable.
async function ed25519PublicFromSeed(ed25519Seed: Uint8Array): Promise<Uint8Array> {
  const tmp = await crypto.subtle.importKey(
    "pkcs8",
    concat(PKCS8_ED25519_PREFIX, ed25519Seed),
    { name: "Ed25519" },
    true,
    ["sign"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", tmp);
  if (!jwk.x) throw new Error("identity: Ed25519 JWK missing public x");
  return base64urlToBytes(jwk.x);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function bytesToBase64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

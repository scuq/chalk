// chalk -- space-key cryptography, with crypto-agility built in.
//
// A "space" is a channel. Each channel has one long-lived 256-bit symmetric
// space key that encrypts every message in it (AES-256-GCM). The space key
// is wrapped once per member, to that member's X25519 identity public key,
// via an ephemeral-static sealed box (ECIES).
//
// CRYPTO-AGILITY (see docs/design/crypto-agility.md). Algorithms WILL need
// to change over the years -- most likely a post-quantum migration. So every
// artifact is self-describing and dispatched through a suite registry that
// never drops an old suite, which makes migration lossless:
//
//   * Each encrypted message body starts with a 1-byte MESSAGE-suite tag:
//         body = msgSuite(1) || nonce || ciphertext || tag
//   * Each wrapped key carries a WRAP-suite id (stored in
//     channel_keys.wrap_suite) alongside an opaque, suite-defined blob.
//   * Wrap and message suites are INDEPENDENT integers: a PQ migration can
//     bump the wrap suite (the quantum-vulnerable KEM) while leaving the
//     message suite untouched -- AES-256-GCM is already PQ-durable, so old
//     messages keep decrypting under the same space key (cheap "re-wrap"
//     migration; full per-message "re-encrypt" is possible but rarely
//     needed). Old suites stay registered forever, so history is never lost.
//
// Adding a suite later = add a constant, a `case` in the dispatch, and a v_
// implementation. No format change; no migration of existing data required.
//
// Suite 1 (today):
//   WRAP_SUITE_X25519_AESGCM = X25519 ECDH -> HKDF-SHA256 -> AES-256-GCM
//   MSG_SUITE_AESGCM         = AES-256-GCM
//
// AADs bind the suite + slot so nothing can be relocated or reinterpreted by
// a blind relay:
//   msg  AAD = "chalk-msg-s{suite}:{channelID}:{keyVersion}"
//   wrap AAD = "chalk-wrap-s{suite}:{channelID}:{keyVersion}:{recipientID}"
//
// Random 96-bit nonces; explicit chalk HKDF salt/info. All native WebCrypto.
// wrap/unwrap/decrypt return null (never throw) on any failure.

// ---- suite ids (independent wrap vs message) ----------------------------

export const WRAP_SUITE_X25519_AESGCM = 1;
export const MSG_SUITE_AESGCM = 1;

/** The suites new artifacts are produced under. Bump on migration. */
export const CURRENT_WRAP_SUITE = WRAP_SUITE_X25519_AESGCM;
export const CURRENT_MSG_SUITE = MSG_SUITE_AESGCM;

/**
 * SuiteDescription -- human-readable, TRUTHFUL summary of a wrap+message suite
 * pair, for display (e.g. the encryption-info tooltip). Sourced from the suite
 * constants so it stays in sync: change the suite, change what's shown.
 */
export interface SuiteDescription {
  cipher: string; // message cipher
  keyExchange: string; // how the space key is wrapped to a member
  keyBits: number; // symmetric space-key length
  wrapSuite: number;
  msgSuite: number;
}

/** describeSuites returns the display summary for the current suite pair. */
export function describeSuites(): SuiteDescription {
  // The switch mirrors the wrap/encrypt dispatch so descriptions can never
  // drift from what is actually produced.
  let cipher = "unknown";
  switch (CURRENT_MSG_SUITE) {
    case MSG_SUITE_AESGCM:
      cipher = "AES-256-GCM";
      break;
  }
  let keyExchange = "unknown";
  switch (CURRENT_WRAP_SUITE) {
    case WRAP_SUITE_X25519_AESGCM:
      keyExchange = "X25519 ECDH + HKDF-SHA256";
      break;
  }
  return {
    cipher,
    keyExchange,
    keyBits: SPACE_KEY_BYTES * 8, // 256
    wrapSuite: CURRENT_WRAP_SUITE,
    msgSuite: CURRENT_MSG_SUITE,
  };
}

const HKDF_SALT = utf8("chalk-spacekey-hkdf-salt-v1");
const HKDF_INFO = utf8("chalk-spacekey-wrap-v1");

const SPACE_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const X25519_PUB_BYTES = 32;
const WRAPPED_BYTES = SPACE_KEY_BYTES + GCM_TAG_BYTES; // 48
// suite-1 wrap blob = ephemeralPub(32) || nonce(12) || wrapped(48)
const WRAP_V1_BLOB_BYTES = X25519_PUB_BYTES + NONCE_BYTES + WRAPPED_BYTES; // 92

/**
 * A space key wrapped to one member. `suite` is stored in
 * channel_keys.wrap_suite; `blob` is the suite-defined serialization.
 */
export interface WrappedKey {
  suite: number;
  blob: Uint8Array;
}

/** generateSpaceKey returns a fresh random 256-bit space key (raw bytes). */
export function generateSpaceKey(): Uint8Array {
  const k = new Uint8Array(SPACE_KEY_BYTES);
  crypto.getRandomValues(k);
  return k;
}

// ---- wrap / unwrap (dispatched by wrap suite) ---------------------------

/**
 * wrapSpaceKey seals the space key to a member's X25519 public key under the
 * current wrap suite. Returns { suite, blob } to store in channel_keys.
 */
export async function wrapSpaceKey(
  spaceKey: Uint8Array,
  recipientX25519Pub: Uint8Array,
  channelID: string,
  keyVersion: number,
  recipientID: string,
): Promise<WrappedKey> {
  if (spaceKey.length !== SPACE_KEY_BYTES) {
    throw new Error(`spacekey: space key must be ${SPACE_KEY_BYTES} bytes`);
  }
  switch (CURRENT_WRAP_SUITE) {
    case WRAP_SUITE_X25519_AESGCM: {
      const blob = await wrapV1(spaceKey, recipientX25519Pub, channelID, keyVersion, recipientID);
      return { suite: WRAP_SUITE_X25519_AESGCM, blob };
    }
    default:
      throw new Error(`spacekey: unknown current wrap suite ${CURRENT_WRAP_SUITE}`);
  }
}

/**
 * unwrapSpaceKey opens a wrapped key with the member's X25519 private key,
 * dispatching on wrap.suite. Returns the 32-byte space key, or null if the
 * suite is unknown, the blob is malformed, the key is wrong, or the
 * (channelID, keyVersion, recipientID) slot doesn't match. Never throws.
 */
export async function unwrapSpaceKey(
  wrap: WrappedKey,
  ownX25519Private: CryptoKey,
  channelID: string,
  keyVersion: number,
  recipientID: string,
): Promise<Uint8Array | null> {
  switch (wrap.suite) {
    case WRAP_SUITE_X25519_AESGCM:
      return unwrapV1(wrap.blob, ownX25519Private, channelID, keyVersion, recipientID);
    default:
      return null; // unknown/retired suite the client can't speak
  }
}

// ---- message encrypt / decrypt (dispatched by message suite) ------------

/**
 * encryptMessage AES-256-GCM-encrypts a message under the space key with the
 * current message suite. Returns a self-describing body:
 *   msgSuite(1) || nonce(12) || ciphertext || tag(16)
 */
export async function encryptMessage(
  spaceKey: Uint8Array,
  channelID: string,
  keyVersion: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  switch (CURRENT_MSG_SUITE) {
    case MSG_SUITE_AESGCM: {
      const inner = await encMsgV1(spaceKey, channelID, keyVersion, plaintext);
      return concat(Uint8Array.of(MSG_SUITE_AESGCM), inner);
    }
    default:
      throw new Error(`spacekey: unknown current message suite ${CURRENT_MSG_SUITE}`);
  }
}

/**
 * decryptMessage reads the leading message-suite tag and dispatches. Returns
 * the plaintext, or null if the suite is unknown, the body is malformed, the
 * key/version/channel is wrong, or the ciphertext was tampered with. Never
 * throws.
 */
export async function decryptMessage(
  spaceKey: Uint8Array,
  channelID: string,
  keyVersion: number,
  body: Uint8Array,
): Promise<Uint8Array | null> {
  if (body.length < 1) return null;
  const suite = body[0];
  const inner = body.subarray(1);
  switch (suite) {
    case MSG_SUITE_AESGCM:
      return decMsgV1(spaceKey, channelID, keyVersion, inner);
    default:
      return null; // unknown/retired suite
  }
}

// ---- suite 1 implementations --------------------------------------------

async function wrapV1(
  spaceKey: Uint8Array,
  recipientX25519Pub: Uint8Array,
  channelID: string,
  keyVersion: number,
  recipientID: string,
): Promise<Uint8Array> {
  const eph = (await crypto.subtle.generateKey({ name: "X25519" }, false, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const ephemeralPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const recipientPub = await crypto.subtle.importKey("raw", recipientX25519Pub, { name: "X25519" }, false, []);
  const shared = await crypto.subtle.deriveBits({ name: "X25519", public: recipientPub }, eph.privateKey, 256);
  const wrapKey = await hkdfWrapKey(shared, ["encrypt"]);
  const nonce = randomNonce();
  const wrapped = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: wrapAAD(WRAP_SUITE_X25519_AESGCM, channelID, keyVersion, recipientID) },
      wrapKey,
      spaceKey,
    ),
  );
  return concat(ephemeralPub, concat(nonce, wrapped));
}

async function unwrapV1(
  blob: Uint8Array,
  ownX25519Private: CryptoKey,
  channelID: string,
  keyVersion: number,
  recipientID: string,
): Promise<Uint8Array | null> {
  try {
    if (blob.length !== WRAP_V1_BLOB_BYTES) return null;
    const ephemeralPubBytes = blob.subarray(0, X25519_PUB_BYTES);
    const nonce = blob.subarray(X25519_PUB_BYTES, X25519_PUB_BYTES + NONCE_BYTES);
    const wrapped = blob.subarray(X25519_PUB_BYTES + NONCE_BYTES);
    const ephemeralPub = await crypto.subtle.importKey("raw", ephemeralPubBytes, { name: "X25519" }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "X25519", public: ephemeralPub }, ownX25519Private, 256);
    const wrapKey = await hkdfWrapKey(shared, ["decrypt"]);
    const spaceKey = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: wrapAAD(WRAP_SUITE_X25519_AESGCM, channelID, keyVersion, recipientID) },
        wrapKey,
        wrapped,
      ),
    );
    return spaceKey.length === SPACE_KEY_BYTES ? spaceKey : null;
  } catch {
    return null;
  }
}

async function encMsgV1(
  spaceKey: Uint8Array,
  channelID: string,
  keyVersion: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const key = await importSpaceKey(spaceKey, ["encrypt"]);
  const nonce = randomNonce();
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: msgAAD(MSG_SUITE_AESGCM, channelID, keyVersion) },
      key,
      plaintext,
    ),
  );
  return concat(nonce, ct);
}

async function decMsgV1(
  spaceKey: Uint8Array,
  channelID: string,
  keyVersion: number,
  inner: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    if (inner.length < NONCE_BYTES + GCM_TAG_BYTES) return null;
    const key = await importSpaceKey(spaceKey, ["decrypt"]);
    const nonce = inner.subarray(0, NONCE_BYTES);
    const ct = inner.subarray(NONCE_BYTES);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: msgAAD(MSG_SUITE_AESGCM, channelID, keyVersion) },
      key,
      ct,
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

// ---- shared internals ---------------------------------------------------

async function hkdfWrapKey(shared: ArrayBuffer, usages: KeyUsage[]): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    usages,
  );
}

function importSpaceKey(spaceKey: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", spaceKey, { name: "AES-GCM" }, false, usages);
}

function wrapAAD(suite: number, channelID: string, keyVersion: number, recipientID: string): Uint8Array {
  return utf8(`chalk-wrap-s${suite}:${channelID}:${keyVersion}:${recipientID}`);
}

function msgAAD(suite: number, channelID: string, keyVersion: number): Uint8Array {
  return utf8(`chalk-msg-s${suite}:${channelID}:${keyVersion}`);
}

function randomNonce(): Uint8Array {
  const n = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(n);
  return n;
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

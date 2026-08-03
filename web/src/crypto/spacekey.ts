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
// Wrap suites:
//   1  WRAP_SUITE_X25519_AESGCM         X25519 ECDH -> HKDF-SHA256 -> AES-256-GCM
//   2  WRAP_SUITE_X25519_AESGCM_ED25519 suite 1 + an Ed25519 signature (82-1)
// Message suite:
//   1  MSG_SUITE_AESGCM                 AES-256-GCM
//
// AADs bind the suite + slot so nothing can be relocated or reinterpreted by
// a blind relay:
//   msg  AAD = "chalk-msg-s{suite}:{channelID}:{keyVersion}"
//   wrap AAD = "chalk-wrap-s{suite}:{channelID}:{keyVersion}:{recipientID}"
//
// 82-1: WHY SUITE 2 EXISTS. Suite 1 is sealed TO a recipient but signed by
// nobody, and minting one needs only the recipient's PUBLIC X25519 key -- which
// the server stores. So the server can generate a space key it knows, wrap it
// correctly, and have it accepted (audit finding C-01). Suite 2 appends the
// wrapper's Ed25519 identity signature over the sealed bytes and the slot, so a
// wrap is only as trustworthy as the key the RECIPIENT already trusts.
//
// The signature lives INSIDE the opaque blob rather than in new columns,
// per this file's agility contract: wrap_suite + opaque blob already reach every
// surface that carries a wrap, so suite 2 needs no schema, wire or migration
// change. A fixed `wrap_sig` column would also be the wrong shape the moment a
// suite authenticates differently (an ML-DSA signature is ~2.4-4.6 KB).
//
// 82-5: suite 2 is now CURRENT_WRAP_SUITE, so every wrap chalk produces for a
// member is signed. 82-7 signed the guest-invite mint too, so NOTHING produces
// suite 1 any more. It stays registered forever regardless -- existing channels
// and outstanding guest links are full of it and it must keep opening.
//
// Random 96-bit nonces; explicit chalk HKDF salt/info. All native WebCrypto.
// wrap/unwrap/decrypt return null (never throw) on any failure; the SIGNING
// entry point throws on degenerate input, mirroring voice/signal-crypto.ts.

// ---- suite ids (independent wrap vs message) ----------------------------

export const WRAP_SUITE_X25519_AESGCM = 1;
export const WRAP_SUITE_X25519_AESGCM_ED25519 = 2;
export const MSG_SUITE_AESGCM = 1;

/**
 * The suites new artifacts are produced under. Bump on migration.
 *
 * Typed `number`, not the literal: these are registry pointers that move, and
 * a literal type would make every other suite's `case` look unreachable to the
 * compiler -- which is exactly backwards for a registry whose whole job is to
 * keep handling suites it no longer produces.
 */
export const CURRENT_WRAP_SUITE: number = WRAP_SUITE_X25519_AESGCM_ED25519;
export const CURRENT_MSG_SUITE: number = MSG_SUITE_AESGCM;

/**
 * SuiteDescription -- human-readable, TRUTHFUL summary of a wrap+message suite
 * pair, for display (e.g. the encryption-info tooltip). Sourced from the suite
 * constants so it stays in sync: change the suite, change what's shown.
 */
export interface SuiteDescription {
  cipher: string; // message cipher
  keyExchange: string; // how the space key is wrapped to a member
  keyAuth: string; // what proves WHO produced that wrap
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
  // Key exchange and key AUTHENTICATION are reported separately because they
  // are separate properties: suite 2 changes only the second, and folding both
  // into one line is how a UI ends up implying the wrong one improved.
  let keyExchange = "unknown";
  let keyAuth = "unknown";
  switch (CURRENT_WRAP_SUITE) {
    case WRAP_SUITE_X25519_AESGCM:
      keyExchange = "X25519 ECDH + HKDF-SHA256";
      keyAuth = "none";
      break;
    case WRAP_SUITE_X25519_AESGCM_ED25519:
      keyExchange = "X25519 ECDH + HKDF-SHA256";
      keyAuth = "Ed25519";
      break;
  }
  return {
    cipher,
    keyExchange,
    keyAuth,
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

const ED25519_PUB_BYTES = 32;
const ED25519_SIG_BYTES = 64;
// suite-2 wrap blob = <suite-1 blob>(92) || signerEd25519Pub(32) || sig(64)
// The leading 92 bytes are a byte-identical suite-1 sealed box, so suite 2
// reuses that implementation rather than restating it.
const WRAP_V2_BLOB_BYTES = WRAP_V1_BLOB_BYTES + ED25519_PUB_BYTES + ED25519_SIG_BYTES; // 188

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
 * WrapSlot is the (channel, version, recipient) address a wrap is valid for.
 * Bound into both the AAD and the signature, so a wrap cannot be relocated to
 * another channel, another key version, or another member.
 */
export interface WrapSlot {
  channelID: string;
  keyVersion: number;
  recipientID: string;
}

/**
 * WrapSigner is the identity a wrap is produced under.
 *
 * wrapSpaceKey requires it even while the current suite is unsigned. That is
 * deliberate: it means bumping CURRENT_WRAP_SUITE to a signing suite is a
 * one-line change here rather than a migration of every caller, and a producer
 * with no signing material to hand cannot come into existence in between.
 */
export interface WrapSigner {
  userID: string;
  ed25519Private: CryptoKey; // non-extractable, sign-only
  ed25519Public: Uint8Array;
}

/**
 * wrapSpaceKey seals the space key to a member's X25519 public key under the
 * current wrap suite. Returns { suite, blob } to store in channel_keys.
 *
 * This is THE producer: every wrap chalk writes for a member comes through
 * here, so what the current suite is decides what the whole system emits.
 */
export async function wrapSpaceKey(
  spaceKey: Uint8Array,
  recipientX25519Pub: Uint8Array,
  slot: WrapSlot,
  signer: WrapSigner,
): Promise<WrappedKey> {
  switch (CURRENT_WRAP_SUITE) {
    case WRAP_SUITE_X25519_AESGCM:
      return wrapSpaceKeyUnsigned(spaceKey, recipientX25519Pub, slot);
    case WRAP_SUITE_X25519_AESGCM_ED25519:
      return wrapSpaceKeySigned(
        spaceKey,
        recipientX25519Pub,
        slot,
        signer.userID,
        signer.ed25519Private,
        signer.ed25519Public,
      );
    default:
      throw new Error(`spacekey: unknown current wrap suite ${CURRENT_WRAP_SUITE}`);
  }
}

/**
 * wrapSpaceKeyUnsigned produces a suite-1 wrap explicitly, whatever the current
 * suite is.
 *
 * Since 82-7 it has NO production caller -- the guest mint, its last one, signs
 * now that the link fragment carries the owner's key. It stays because suite-1
 * *opening* must work forever (old channel rows, outstanding guest links), and
 * the tests that prove that need a way to produce the artifact under test.
 * Named for what it gives up so that it cannot be reached for by accident.
 */
export async function wrapSpaceKeyUnsigned(
  spaceKey: Uint8Array,
  recipientX25519Pub: Uint8Array,
  slot: WrapSlot,
): Promise<WrappedKey> {
  if (spaceKey.length !== SPACE_KEY_BYTES) {
    throw new Error(`spacekey: space key must be ${SPACE_KEY_BYTES} bytes`);
  }
  const blob = await sealBox(
    spaceKey,
    recipientX25519Pub,
    WRAP_SUITE_X25519_AESGCM,
    slot.channelID,
    slot.keyVersion,
    slot.recipientID,
  );
  return { suite: WRAP_SUITE_X25519_AESGCM, blob };
}

/**
 * unwrapSpaceKey opens a wrapped key with the member's X25519 private key,
 * dispatching on wrap.suite. Returns the 32-byte space key, or null if the
 * suite is unknown, the blob is malformed, the key is wrong, or the
 * (channelID, keyVersion, recipientID) slot doesn't match. Never throws.
 *
 * 82-1: this is the UNSIGNED path and it refuses suite 2 by omission -- opening
 * a signed wrap requires a trusted signer key, which this signature cannot
 * express. Callers holding a suite-2 wrap must go through
 * unwrapSpaceKeySigned and decide whom they trust.
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

// ---- signed wraps (suite 2) ---------------------------------------------

const WRAP_SIG_DOMAIN = utf8("chalk-wrap-sig.v1");

/**
 * canonicalWrapMessage builds the bytes an Ed25519 wrap signature covers.
 *
 *   utf8("chalk-wrap-sig.v1") || u8(suite) || u32be(keyVersion)
 *     || lp(channelID) || lp(recipientID) || lp(signerUserID) || lp(sealed)
 *
 * where lp(x) = u32be(x.length) || x.
 *
 * INJECTIVE, which is the whole point: the domain prefix is a fixed-length
 * constant, suite and keyVersion are fixed width, and every remaining field
 * carries its own length. A left-to-right parse therefore recovers the field
 * boundaries from the byte string alone, so distinct inputs cannot collide.
 *
 * Note this deliberately does NOT copy voice/signal-crypto.ts's newline join.
 * That encoding is injective only because every field there is newline-free;
 * `sealed` is ciphertext and contains 0x0A about a third of the time.
 *
 * The SEALED BYTES are signed, not the space key: signing the plaintext key
 * would let anyone who ever held it re-attribute someone else's wrap.
 */
export function canonicalWrapMessage(
  suite: number,
  slot: WrapSlot,
  signerUserID: string,
  sealed: Uint8Array,
): Uint8Array {
  const head = new Uint8Array(WRAP_SIG_DOMAIN.length + 1 + 4);
  head.set(WRAP_SIG_DOMAIN, 0);
  head[WRAP_SIG_DOMAIN.length] = suite & 0xff;
  writeU32BE(head, WRAP_SIG_DOMAIN.length + 1, slot.keyVersion);
  return concat(
    head,
    concat(
      lengthPrefixed(utf8(slot.channelID)),
      concat(
        lengthPrefixed(utf8(slot.recipientID)),
        concat(lengthPrefixed(utf8(signerUserID)), lengthPrefixed(sealed)),
      ),
    ),
  );
}

/**
 * wrapSignerKey returns the raw Ed25519 public key a signed wrap claims to be
 * signed by, or null for an unsigned suite or a malformed blob.
 *
 * This is a CLAIM, not a verified fact -- it is what the blob says. Callers use
 * it to look the signer up in their own trust store; the returned key is only
 * meaningful once unwrapSpaceKeySigned has been given a key the caller trusts.
 */
export function wrapSignerKey(wrap: WrappedKey): Uint8Array | null {
  if (wrap.suite !== WRAP_SUITE_X25519_AESGCM_ED25519) return null;
  if (wrap.blob.length !== WRAP_V2_BLOB_BYTES) return null;
  return wrap.blob.subarray(WRAP_V1_BLOB_BYTES, WRAP_V1_BLOB_BYTES + ED25519_PUB_BYTES);
}

/**
 * wrapSpaceKeySigned seals the space key to a member AND signs the result with
 * the wrapper's Ed25519 identity key.
 *
 * THROWS on degenerate input (empty ids, bad key lengths, out-of-range
 * version) -- those are programmer errors, not attacker input, and silently
 * producing an unusable wrap would be worse. Mirrors signFingerprints.
 */
export async function wrapSpaceKeySigned(
  spaceKey: Uint8Array,
  recipientX25519Pub: Uint8Array,
  slot: WrapSlot,
  signerUserID: string,
  signerEd25519Private: CryptoKey,
  signerEd25519Public: Uint8Array,
): Promise<WrappedKey> {
  if (spaceKey.length !== SPACE_KEY_BYTES) {
    throw new Error(`spacekey: space key must be ${SPACE_KEY_BYTES} bytes`);
  }
  if (signerEd25519Public.length !== ED25519_PUB_BYTES) {
    throw new Error(`spacekey: signer ed25519 public key must be ${ED25519_PUB_BYTES} bytes`);
  }
  if (!slot.channelID || !slot.recipientID || !signerUserID) {
    throw new Error("spacekey: channelID, recipientID and signerUserID are required");
  }
  if (!Number.isInteger(slot.keyVersion) || slot.keyVersion < 1 || slot.keyVersion > 0xffffffff) {
    throw new Error(`spacekey: keyVersion out of range: ${slot.keyVersion}`);
  }
  const suite = WRAP_SUITE_X25519_AESGCM_ED25519;
  const sealed = await sealBox(
    spaceKey,
    recipientX25519Pub,
    suite,
    slot.channelID,
    slot.keyVersion,
    slot.recipientID,
  );
  const msg = canonicalWrapMessage(suite, slot, signerUserID, sealed);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, signerEd25519Private, msg));
  if (sig.length !== ED25519_SIG_BYTES) {
    throw new Error(`spacekey: unexpected Ed25519 signature length ${sig.length}`);
  }
  return { suite, blob: concat(sealed, concat(signerEd25519Public, sig)) };
}

/**
 * unwrapSpaceKeySigned verifies a signed wrap and then opens it. Returns null
 * -- never throws -- on any failure.
 *
 * `signerEd25519Public` is the key the CALLER has already decided to trust, and
 * `signerUserID` is who they believe it belongs to. Passing them is mandatory,
 * which is the structural property that matters: there is no way to open a
 * signed wrap without having first made a trust decision. A blob whose embedded
 * key differs from the trusted one is refused before any crypto runs.
 *
 * Verify-then-decrypt: a forged wrap never reaches the X25519 private key.
 */
export async function unwrapSpaceKeySigned(
  wrap: WrappedKey,
  ownX25519Private: CryptoKey,
  slot: WrapSlot,
  signerUserID: string,
  signerEd25519Public: Uint8Array,
): Promise<Uint8Array | null> {
  try {
    if (wrap.suite !== WRAP_SUITE_X25519_AESGCM_ED25519) return null;
    if (wrap.blob.length !== WRAP_V2_BLOB_BYTES) return null;
    if (signerEd25519Public.length !== ED25519_PUB_BYTES) return null;

    const sealed = wrap.blob.subarray(0, WRAP_V1_BLOB_BYTES);
    const claimedPub = wrap.blob.subarray(WRAP_V1_BLOB_BYTES, WRAP_V1_BLOB_BYTES + ED25519_PUB_BYTES);
    const sig = wrap.blob.subarray(WRAP_V1_BLOB_BYTES + ED25519_PUB_BYTES);

    // The blob must name the key we were told to trust. Public values, so no
    // constant-time requirement.
    if (!bytesEqual(claimedPub, signerEd25519Public)) return null;

    const verifyKey = await crypto.subtle.importKey("raw", signerEd25519Public, { name: "Ed25519" }, false, [
      "verify",
    ]);
    const msg = canonicalWrapMessage(wrap.suite, slot, signerUserID, sealed);
    const ok = await crypto.subtle.verify({ name: "Ed25519" }, verifyKey, sig, msg);
    if (!ok) return null;

    return await openBox(
      sealed,
      ownX25519Private,
      wrap.suite,
      slot.channelID,
      slot.keyVersion,
      slot.recipientID,
    );
  } catch {
    return null;
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

// sealBox / openBox are the ephemeral-static sealed box shared by every wrap
// suite. `suite` only reaches the AAD -- which is exactly what stops a sealed
// box made for one suite being reinterpreted under another (see the splice
// tests in spacekey.test.ts).
async function sealBox(
  spaceKey: Uint8Array,
  recipientX25519Pub: Uint8Array,
  suite: number,
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
      { name: "AES-GCM", iv: nonce, additionalData: wrapAAD(suite, channelID, keyVersion, recipientID) },
      wrapKey,
      spaceKey,
    ),
  );
  return concat(ephemeralPub, concat(nonce, wrapped));
}

async function openBox(
  sealed: Uint8Array,
  ownX25519Private: CryptoKey,
  suite: number,
  channelID: string,
  keyVersion: number,
  recipientID: string,
): Promise<Uint8Array | null> {
  try {
    if (sealed.length !== WRAP_V1_BLOB_BYTES) return null;
    const ephemeralPubBytes = sealed.subarray(0, X25519_PUB_BYTES);
    const nonce = sealed.subarray(X25519_PUB_BYTES, X25519_PUB_BYTES + NONCE_BYTES);
    const wrapped = sealed.subarray(X25519_PUB_BYTES + NONCE_BYTES);
    const ephemeralPub = await crypto.subtle.importKey("raw", ephemeralPubBytes, { name: "X25519" }, false, []);
    const shared = await crypto.subtle.deriveBits({ name: "X25519", public: ephemeralPub }, ownX25519Private, 256);
    const wrapKey = await hkdfWrapKey(shared, ["decrypt"]);
    const spaceKey = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: wrapAAD(suite, channelID, keyVersion, recipientID) },
        wrapKey,
        wrapped,
      ),
    );
    return spaceKey.length === SPACE_KEY_BYTES ? spaceKey : null;
  } catch {
    return null;
  }
}

function unwrapV1(
  blob: Uint8Array,
  ownX25519Private: CryptoKey,
  channelID: string,
  keyVersion: number,
  recipientID: string,
): Promise<Uint8Array | null> {
  return openBox(blob, ownX25519Private, WRAP_SUITE_X25519_AESGCM, channelID, keyVersion, recipientID);
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

function writeU32BE(buf: Uint8Array, offset: number, n: number): void {
  buf[offset] = (n >>> 24) & 0xff;
  buf[offset + 1] = (n >>> 16) & 0xff;
  buf[offset + 2] = (n >>> 8) & 0xff;
  buf[offset + 3] = n & 0xff;
}

/** lengthPrefixed returns u32be(x.length) || x -- the injectivity primitive. */
function lengthPrefixed(x: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + x.length);
  writeU32BE(out, 0, x.length);
  out.set(x, 4);
  return out;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

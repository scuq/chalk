// Tests for src/crypto/spacekey.ts (suite-aware). Validated at authoring
// time against an independent Node X25519 ECDH; these assert the functional
// round-trips, the AAD slot binding, the self-describing suite framing, and
// that tampering / wrong keys / unknown suites all fail closed.
//
// Run via `node test.mjs` from web/.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  generateSpaceKey,
  wrapSpaceKey,
  unwrapSpaceKey,
  wrapSpaceKeySigned,
  unwrapSpaceKeySigned,
  wrapSignerKey,
  canonicalWrapMessage,
  encryptMessage,
  decryptMessage,
  WRAP_SUITE_X25519_AESGCM,
  WRAP_SUITE_X25519_AESGCM_ED25519,
  MSG_SUITE_AESGCM,
  CURRENT_WRAP_SUITE,
  CURRENT_MSG_SUITE,
  type WrapSlot,
} from "./spacekey";

function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

async function makeRecipient(): Promise<{ priv: CryptoKey; pub: Uint8Array }> {
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { priv: kp.privateKey, pub };
}

const CH = "11111111-2222-3333-4444-555555555555";
const VER = 1;
const RID = "user-bob";

test("generateSpaceKey returns 32 random bytes; two differ", () => {
  const a = generateSpaceKey();
  const b = generateSpaceKey();
  assert.equal(a.length, 32);
  assert.notEqual(bytesToHex(a), bytesToHex(b));
});

test("wrap returns the current wrap suite + a 92-byte suite-1 blob", async () => {
  const sk = generateSpaceKey();
  const bob = await makeRecipient();
  const w = await wrapSpaceKey(sk, bob.pub, CH, VER, RID);
  assert.equal(w.suite, WRAP_SUITE_X25519_AESGCM);
  assert.equal(w.suite, CURRENT_WRAP_SUITE);
  assert.equal(w.blob.length, 32 + 12 + 48); // ephPub + nonce + wrapped
});

test("wrap -> unwrap recovers the exact space key", async () => {
  const sk = generateSpaceKey();
  const bob = await makeRecipient();
  const w = await wrapSpaceKey(sk, bob.pub, CH, VER, RID);
  const got = await unwrapSpaceKey(w, bob.priv, CH, VER, RID);
  assert.notEqual(got, null);
  assert.equal(bytesToHex(got!), bytesToHex(sk));
});

test("unwrap rejects an unknown/retired wrap suite", async () => {
  const sk = generateSpaceKey();
  const bob = await makeRecipient();
  const w = await wrapSpaceKey(sk, bob.pub, CH, VER, RID);
  const got = await unwrapSpaceKey({ suite: 99, blob: w.blob }, bob.priv, CH, VER, RID);
  assert.equal(got, null);
});

test("unwrap rejects a wrong slot (channel / version / recipient bound in AAD)", async () => {
  const sk = generateSpaceKey();
  const bob = await makeRecipient();
  const w = await wrapSpaceKey(sk, bob.pub, CH, VER, RID);
  assert.equal(await unwrapSpaceKey(w, bob.priv, "other-channel", VER, RID), null);
  assert.equal(await unwrapSpaceKey(w, bob.priv, CH, 2, RID), null);
  assert.equal(await unwrapSpaceKey(w, bob.priv, CH, VER, "user-eve"), null);
});

test("unwrap with the wrong private key returns null", async () => {
  const sk = generateSpaceKey();
  const bob = await makeRecipient();
  const eve = await makeRecipient();
  const w = await wrapSpaceKey(sk, bob.pub, CH, VER, RID);
  assert.equal(await unwrapSpaceKey(w, eve.priv, CH, VER, RID), null);
});

test("unwrap of a malformed blob returns null (never throws)", async () => {
  const bob = await makeRecipient();
  assert.equal(await unwrapSpaceKey({ suite: WRAP_SUITE_X25519_AESGCM, blob: new Uint8Array(10) }, bob.priv, CH, VER, RID), null);
});

test("encrypted message body is self-describing (leading message-suite tag)", async () => {
  const sk = generateSpaceKey();
  const msg = new TextEncoder().encode("tag me");
  const body = await encryptMessage(sk, CH, VER, msg);
  assert.equal(body[0], MSG_SUITE_AESGCM);
  assert.equal(body[0], CURRENT_MSG_SUITE);
  // suite(1) + nonce(12) + ct + tag(16)
  assert.equal(body.length, 1 + 12 + msg.length + 16);
});

test("message encrypt -> decrypt recovers the plaintext", async () => {
  const sk = generateSpaceKey();
  const msg = new TextEncoder().encode("hello encrypted world ✓");
  const body = await encryptMessage(sk, CH, VER, msg);
  const dec = await decryptMessage(sk, CH, VER, body);
  assert.notEqual(dec, null);
  assert.equal(bytesToHex(dec!), bytesToHex(msg));
});

test("decrypt rejects an unknown leading message suite", async () => {
  const sk = generateSpaceKey();
  const body = await encryptMessage(sk, CH, VER, new TextEncoder().encode("x"));
  const flipped = body.slice();
  flipped[0] = 99; // unknown suite tag
  assert.equal(await decryptMessage(sk, CH, VER, flipped), null);
});

test("message decrypt rejects wrong channel or version (AAD)", async () => {
  const sk = generateSpaceKey();
  const body = await encryptMessage(sk, CH, VER, new TextEncoder().encode("secret"));
  assert.equal(await decryptMessage(sk, "other", VER, body), null);
  assert.equal(await decryptMessage(sk, CH, 9, body), null);
});

test("message decrypt rejects a tampered ciphertext (GCM tag)", async () => {
  const sk = generateSpaceKey();
  const body = await encryptMessage(sk, CH, VER, new TextEncoder().encode("secret"));
  const tampered = body.slice();
  tampered[body.length - 1] ^= 1;
  assert.equal(await decryptMessage(sk, CH, VER, tampered), null);
});

test("message decrypt with the wrong space key returns null", async () => {
  const sk = generateSpaceKey();
  const other = generateSpaceKey();
  const body = await encryptMessage(sk, CH, VER, new TextEncoder().encode("secret"));
  assert.equal(await decryptMessage(other, CH, VER, body), null);
});

test("decrypt of empty / too-short input returns null", async () => {
  const sk = generateSpaceKey();
  assert.equal(await decryptMessage(sk, CH, VER, new Uint8Array(0)), null);
  assert.equal(await decryptMessage(sk, CH, VER, new Uint8Array(3)), null);
});

test("end-to-end: wrap to member, member unwraps, then decrypts a message", async () => {
  const sk = generateSpaceKey();
  const bob = await makeRecipient();
  const body = await encryptMessage(sk, CH, VER, new TextEncoder().encode("welcome Bob"));
  const w = await wrapSpaceKey(sk, bob.pub, CH, VER, "bob");
  const bobKey = await unwrapSpaceKey(w, bob.priv, CH, VER, "bob");
  assert.notEqual(bobKey, null);
  const dec = await decryptMessage(bobKey!, CH, VER, body);
  assert.equal(new TextDecoder().decode(dec!), "welcome Bob");
});

// ---- 82-1: signed wraps (suite 2) ---------------------------------------
//
// The threat these exist for (audit C-01): minting a suite-1 wrap needs only
// the recipient's PUBLIC X25519 key, which the server stores -- so the server
// can seal a space key it chose and have it accepted. Suite 2 must make a wrap
// only as trustworthy as the signing key the recipient already trusts.

async function makeSigner(): Promise<{ priv: CryptoKey; pub: Uint8Array; userID: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { priv: kp.privateKey, pub, userID: "user-alice" };
}

const SLOT: WrapSlot = { channelID: CH, keyVersion: VER, recipientID: RID };

test("signed wrap is suite 2 and 188 bytes (sealed 92 + ed pub 32 + sig 64)", async () => {
  const sk = generateSpaceKey();
  const bob = await makeRecipient();
  const alice = await makeSigner();
  const w = await wrapSpaceKeySigned(sk, bob.pub, SLOT, alice.userID, alice.priv, alice.pub);
  assert.equal(w.suite, WRAP_SUITE_X25519_AESGCM_ED25519);
  assert.equal(w.blob.length, 188);
  assert.equal(bytesToHex(wrapSignerKey(w)!), bytesToHex(alice.pub));
});

test("signed wrap round-trips when the signer is trusted", async () => {
  const sk = generateSpaceKey();
  const bob = await makeRecipient();
  const alice = await makeSigner();
  const w = await wrapSpaceKeySigned(sk, bob.pub, SLOT, alice.userID, alice.priv, alice.pub);
  const got = await unwrapSpaceKeySigned(w, bob.priv, SLOT, alice.userID, alice.pub);
  assert.notEqual(got, null);
  assert.equal(bytesToHex(got!), bytesToHex(sk));
});

// The canonical encoding is length-prefixed rather than newline-joined (the
// voice/signal-crypto.ts style) precisely so field boundaries can't be shifted.
// Newline-joining would make these two inputs produce identical bytes.
test("canonical message is injective across field boundaries", () => {
  const sealed = new Uint8Array(92);
  const a = canonicalWrapMessage(2, { channelID: "a", keyVersion: 1, recipientID: "bc" }, "s", sealed);
  const b = canonicalWrapMessage(2, { channelID: "ab", keyVersion: 1, recipientID: "c" }, "s", sealed);
  assert.notEqual(bytesToHex(a), bytesToHex(b));

  // Same shift, one field over.
  const c = canonicalWrapMessage(2, { channelID: "x", keyVersion: 1, recipientID: "y" }, "zw", sealed);
  const d = canonicalWrapMessage(2, { channelID: "x", keyVersion: 1, recipientID: "yz" }, "w", sealed);
  assert.notEqual(bytesToHex(c), bytesToHex(d));
});

test("canonical message binds suite and key version", () => {
  const sealed = new Uint8Array(92);
  const base = canonicalWrapMessage(2, SLOT, "s", sealed);
  assert.notEqual(bytesToHex(canonicalWrapMessage(3, SLOT, "s", sealed)), bytesToHex(base));
  assert.notEqual(
    bytesToHex(canonicalWrapMessage(2, { ...SLOT, keyVersion: 2 }, "s", sealed)),
    bytesToHex(base),
  );
});

test("signed wrap survives sealed bytes containing newlines and NULs", async () => {
  // Ciphertext is binary; a newline-joined encoding would be ambiguous here.
  // Loop so we actually hit 0x0a/0x00 in the sealed bytes rather than hoping.
  const bob = await makeRecipient();
  const alice = await makeSigner();
  for (let i = 0; i < 24; i++) {
    const sk = generateSpaceKey();
    const w = await wrapSpaceKeySigned(sk, bob.pub, SLOT, alice.userID, alice.priv, alice.pub);
    const got = await unwrapSpaceKeySigned(w, bob.priv, SLOT, alice.userID, alice.pub);
    assert.notEqual(got, null, `iteration ${i}`);
    assert.equal(bytesToHex(got!), bytesToHex(sk));
  }
});

test("signed wrap is refused when the trusted key is not the one that signed", async () => {
  const sk = generateSpaceKey();
  const bob = await makeRecipient();
  const alice = await makeSigner();
  const mallory = await makeSigner();
  const w = await wrapSpaceKeySigned(sk, bob.pub, SLOT, alice.userID, alice.priv, alice.pub);
  // This IS the C-01 defence: the blob is internally valid, but it is not
  // signed by the key the recipient trusts.
  assert.equal(await unwrapSpaceKeySigned(w, bob.priv, SLOT, alice.userID, mallory.pub), null);
});

test("a wrap forged by the server is refused even though it decrypts", async () => {
  // Exactly the attack: the server knows bob's PUBLIC x25519 key, so it can
  // seal a key it chose. It signs with its own identity because it has no
  // other. Suite 2 must reject it.
  const serverKey = generateSpaceKey();
  const bob = await makeRecipient();
  const alice = await makeSigner(); // whom bob trusts
  const server = await makeSigner(); // whom bob does not
  const forged = await wrapSpaceKeySigned(serverKey, bob.pub, SLOT, alice.userID, server.priv, server.pub);

  assert.equal(await unwrapSpaceKeySigned(forged, bob.priv, SLOT, alice.userID, alice.pub), null);
  // And it would have opened, had the signature not been checked -- proving the
  // rejection came from the signature and not from a broken sealed box.
  assert.notEqual(await unwrapSpaceKeySigned(forged, bob.priv, SLOT, alice.userID, server.pub), null);
});

test("signed wrap is refused for a wrong slot", async () => {
  const sk = generateSpaceKey();
  const bob = await makeRecipient();
  const alice = await makeSigner();
  const w = await wrapSpaceKeySigned(sk, bob.pub, SLOT, alice.userID, alice.priv, alice.pub);
  const cases: WrapSlot[] = [
    { ...SLOT, channelID: "other-channel" },
    { ...SLOT, keyVersion: 2 },
    { ...SLOT, recipientID: "user-eve" },
  ];
  for (const slot of cases) {
    assert.equal(await unwrapSpaceKeySigned(w, bob.priv, slot, alice.userID, alice.pub), null);
  }
});

test("signed wrap is refused when the signer's claimed user id differs", async () => {
  const sk = generateSpaceKey();
  const bob = await makeRecipient();
  const alice = await makeSigner();
  const w = await wrapSpaceKeySigned(sk, bob.pub, SLOT, alice.userID, alice.priv, alice.pub);
  // The id is inside the signed message, so a server that re-labels who a key
  // came from produces a verification failure rather than an acceptance.
  assert.equal(await unwrapSpaceKeySigned(w, bob.priv, SLOT, "user-carol", alice.pub), null);
});

test("suites cannot be spliced in either direction", async () => {
  const sk = generateSpaceKey();
  const bob = await makeRecipient();
  const alice = await makeSigner();

  // suite-2 blob presented as suite 1: the unsigned path refuses suite 2, and
  // the 92-byte prefix alone was sealed under the s2 AAD so it won't open.
  const signed = await wrapSpaceKeySigned(sk, bob.pub, SLOT, alice.userID, alice.priv, alice.pub);
  assert.equal(await unwrapSpaceKey(signed, bob.priv, CH, VER, RID), null);
  assert.equal(
    await unwrapSpaceKey(
      { suite: WRAP_SUITE_X25519_AESGCM, blob: signed.blob.subarray(0, 92) },
      bob.priv,
      CH,
      VER,
      RID,
    ),
    null,
  );

  // suite-1 blob with a signature stapled on, presented as suite 2: sealed
  // under the s1 AAD, so it fails even though the signature is over its bytes.
  const plain = await wrapSpaceKey(sk, bob.pub, CH, VER, RID);
  const msg = canonicalWrapMessage(WRAP_SUITE_X25519_AESGCM_ED25519, SLOT, alice.userID, plain.blob);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, alice.priv, msg));
  const spliced = new Uint8Array(188);
  spliced.set(plain.blob, 0);
  spliced.set(alice.pub, 92);
  spliced.set(sig, 124);
  assert.equal(
    await unwrapSpaceKeySigned(
      { suite: WRAP_SUITE_X25519_AESGCM_ED25519, blob: spliced },
      bob.priv,
      SLOT,
      alice.userID,
      alice.pub,
    ),
    null,
  );
});

test("signed unwrap fails closed on malformed input and never throws", async () => {
  const sk = generateSpaceKey();
  const bob = await makeRecipient();
  const alice = await makeSigner();
  const w = await wrapSpaceKeySigned(sk, bob.pub, SLOT, alice.userID, alice.priv, alice.pub);

  const truncated = { suite: w.suite, blob: w.blob.subarray(0, 187) };
  const oversized = { suite: w.suite, blob: new Uint8Array(189) };
  const empty = { suite: w.suite, blob: new Uint8Array(0) };
  for (const bad of [truncated, oversized, empty]) {
    assert.equal(await unwrapSpaceKeySigned(bad, bob.priv, SLOT, alice.userID, alice.pub), null);
  }

  // Garbage signature bytes over an otherwise-valid blob.
  const garbled = w.blob.slice();
  garbled[130] ^= 0xff;
  assert.equal(
    await unwrapSpaceKeySigned({ suite: w.suite, blob: garbled }, bob.priv, SLOT, alice.userID, alice.pub),
    null,
  );

  // A trusted key of the wrong length is refused rather than passed to WebCrypto.
  assert.equal(await unwrapSpaceKeySigned(w, bob.priv, SLOT, alice.userID, new Uint8Array(31)), null);

  // Suite 1 through the signed path.
  const plain = await wrapSpaceKey(sk, bob.pub, CH, VER, RID);
  assert.equal(await unwrapSpaceKeySigned(plain, bob.priv, SLOT, alice.userID, alice.pub), null);
});

test("wrapSignerKey returns null for unsigned or malformed wraps", async () => {
  const sk = generateSpaceKey();
  const bob = await makeRecipient();
  const plain = await wrapSpaceKey(sk, bob.pub, CH, VER, RID);
  assert.equal(wrapSignerKey(plain), null);
  assert.equal(wrapSignerKey({ suite: WRAP_SUITE_X25519_AESGCM_ED25519, blob: new Uint8Array(92) }), null);
});

test("signing refuses degenerate input (throws, unlike verification)", async () => {
  const sk = generateSpaceKey();
  const bob = await makeRecipient();
  const alice = await makeSigner();
  const bad: Array<[string, () => Promise<unknown>]> = [
    ["short space key", () => wrapSpaceKeySigned(new Uint8Array(31), bob.pub, SLOT, alice.userID, alice.priv, alice.pub)],
    ["short signer pub", () => wrapSpaceKeySigned(sk, bob.pub, SLOT, alice.userID, alice.priv, new Uint8Array(31))],
    ["empty channel", () => wrapSpaceKeySigned(sk, bob.pub, { ...SLOT, channelID: "" }, alice.userID, alice.priv, alice.pub)],
    ["empty recipient", () => wrapSpaceKeySigned(sk, bob.pub, { ...SLOT, recipientID: "" }, alice.userID, alice.priv, alice.pub)],
    ["empty signer id", () => wrapSpaceKeySigned(sk, bob.pub, SLOT, "", alice.priv, alice.pub)],
    ["version 0", () => wrapSpaceKeySigned(sk, bob.pub, { ...SLOT, keyVersion: 0 }, alice.userID, alice.priv, alice.pub)],
    ["version overflow", () => wrapSpaceKeySigned(sk, bob.pub, { ...SLOT, keyVersion: 2 ** 32 }, alice.userID, alice.priv, alice.pub)],
  ];
  for (const [name, fn] of bad) {
    await assert.rejects(fn, `${name} should throw`);
  }
});

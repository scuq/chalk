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
  encryptMessage,
  decryptMessage,
  WRAP_SUITE_X25519_AESGCM,
  MSG_SUITE_AESGCM,
  CURRENT_WRAP_SUITE,
  CURRENT_MSG_SUITE,
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

// Unit tests for src/crypto/stub.ts (phase 21-1 passthrough seam).
//
// Verifies the encrypt/decrypt seam round-trips correctly: whatever
// encryptForChannel produces, decryptForChannel must turn back into the
// original plaintext, byte-for-byte, including unicode, emoji, empty
// strings, and long inputs. This is the one-time test for the phase
// 21-1/21-2 changes -- it confirms the message path that App.tsx now
// uses (stub seam) does not corrupt message bodies.
//
// NOTE: the stub is a PASSTHROUGH (no encryption). This test asserts
// correctness of the transport encoding, NOT confidentiality. When phase
// 23 replaces stub.ts with real AES-256-GCM, this same round-trip test
// should keep passing (the interface is identical), and a separate test
// will assert the ciphertext is actually unreadable without the key.
//
// Run via `node test.mjs` from web/.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { encryptForChannel, decryptForChannel } from "./stub";

const CHANNEL = "11111111-2222-3333-4444-555555555555";

// ---- round-trip: encrypt then decrypt yields the original ----

test("stub round-trips a simple ascii message", async () => {
  const msg = "hello world";
  const ct = await encryptForChannel(CHANNEL, msg);
  const pt = await decryptForChannel(CHANNEL, ct);
  assert.equal(pt, msg);
});

test("stub round-trips an empty string", async () => {
  const ct = await encryptForChannel(CHANNEL, "");
  const pt = await decryptForChannel(CHANNEL, ct);
  assert.equal(pt, "");
});

test("stub round-trips unicode and emoji", async () => {
  const msg = "Grüße aus Wien 🦊 — café, naïve, 日本語, Ω≈ç√∫";
  const ct = await encryptForChannel(CHANNEL, msg);
  const pt = await decryptForChannel(CHANNEL, ct);
  assert.equal(pt, msg);
});

test("stub round-trips newlines and control-ish chars", async () => {
  const msg = "line1\nline2\ttabbed\r\nwindows\u0000nul-ish";
  const ct = await encryptForChannel(CHANNEL, msg);
  const pt = await decryptForChannel(CHANNEL, ct);
  assert.equal(pt, msg);
});

test("stub round-trips a long message", async () => {
  const msg = "x".repeat(10000) + "🦊".repeat(500);
  const ct = await encryptForChannel(CHANNEL, msg);
  const pt = await decryptForChannel(CHANNEL, ct);
  assert.equal(pt, msg);
});

// ---- the produced "ciphertext" is valid base64 (what the wire expects) ----

test("stub output is valid base64 the transport can carry", async () => {
  const ct = await encryptForChannel(CHANNEL, "hello world");
  // base64 alphabet only (A-Z a-z 0-9 + / =). The send path base64-encodes
  // the body; the stub already returns base64, so this must hold.
  assert.match(ct, /^[A-Za-z0-9+/]*={0,2}$/);
  // and it decodes back without throwing
  assert.doesNotThrow(() => atob(ct));
});

// ---- channelID does not affect the body (stub ignores it; phase 23 uses it
//      only as AAD, which still must not change the recovered plaintext) ----

test("decrypt is independent of channelID for the stub", async () => {
  const msg = "channel-agnostic body";
  const ct = await encryptForChannel("aaaaaaaa-0000-0000-0000-000000000000", msg);
  // The stub ignores channelID, so decrypting under a different channel
  // still recovers the body. (Phase 23 will bind to channelID via AAD;
  // this assertion is stub-specific and will be replaced then.)
  const pt = await decryptForChannel("bbbbbbbb-0000-0000-0000-000000000000", ct);
  assert.equal(pt, msg);
});

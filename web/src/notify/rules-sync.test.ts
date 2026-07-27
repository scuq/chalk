// The encrypted rules blob: what must round-trip, and what must fail
// CLOSED. The failure cases matter more than the happy path -- a blob
// arrives from the server, which is untrusted by design, so anything
// but a clean decrypt of a known version has to come back null (the
// caller then keeps the local rules).

import { test } from "node:test";
import assert from "node:assert/strict";
import { openRulesConfig, rulesAesKey, sealRulesConfig } from "./rules-sync.ts";
import { defaultRulesConfig, withChannelRule, withUserRule } from "./rules.ts";

const SCALAR = new Uint8Array(32).fill(7);
const OTHER_SCALAR = new Uint8Array(32).fill(8);

function b64decode(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

test("a config round-trips through seal and open", async () => {
  const key = await rulesAesKey(SCALAR);
  const config = withChannelRule(withUserRule(defaultRulesConfig(), "u1", 4), "c1", 0);
  const opened = await openRulesConfig(key, await sealRulesConfig(key, config));
  assert.deepEqual(opened, config);
});

test("the key derivation is deterministic -- two devices, same key", async () => {
  // Seal with a key derived on "device A", open with one derived on
  // "device B" from the same scalar. This IS the sync property.
  const a = await rulesAesKey(SCALAR);
  const b = await rulesAesKey(SCALAR);
  const config = withUserRule(defaultRulesConfig(), "u9", 2);
  assert.deepEqual(await openRulesConfig(b, await sealRulesConfig(a, config)), config);
});

test("a tampered blob opens as null", async () => {
  const key = await rulesAesKey(SCALAR);
  const blob = await sealRulesConfig(key, defaultRulesConfig());
  const bytes = b64decode(blob);
  bytes[bytes.length - 5] ^= 0xff;
  assert.equal(await openRulesConfig(key, b64encode(bytes)), null);
});

test("the wrong key opens as null", async () => {
  const key = await rulesAesKey(SCALAR);
  const other = await rulesAesKey(OTHER_SCALAR);
  const blob = await sealRulesConfig(key, defaultRulesConfig());
  assert.equal(await openRulesConfig(other, blob), null);
});

test("garbage input opens as null, never throws", async () => {
  const key = await rulesAesKey(SCALAR);
  for (const junk of ["", "not base64 !!!", "AAAA", b64encode(new Uint8Array(11))]) {
    assert.equal(await openRulesConfig(key, junk), null, JSON.stringify(junk));
  }
});

test("an unknown payload version opens as null", async () => {
  // A future build might write v2; this build must ignore it rather
  // than misread it. Crafted with the same key and framing, only the
  // version differs.
  const key = await rulesAesKey(SCALAR);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({ v: 2, config: defaultRulesConfig() }),
  );
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext),
  );
  const framed = new Uint8Array(12 + ct.length);
  framed.set(nonce);
  framed.set(ct, 12);
  assert.equal(await openRulesConfig(key, b64encode(framed)), null);
});

test("an opened config is normalized, not trusted", async () => {
  // Another device could be a future build with unknown event types, or
  // a buggy one. Whatever decrypts still goes through normalize.
  const key = await rulesAesKey(SCALAR);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(
    JSON.stringify({
      v: 1,
      config: { rules: { defaults: { message: 9, dm: 2 }, users: { u1: 4 } }, profiles: null },
    }),
  );
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext),
  );
  const framed = new Uint8Array(12 + ct.length);
  framed.set(nonce);
  framed.set(ct, 12);
  const opened = await openRulesConfig(key, b64encode(framed));
  assert.ok(opened);
  assert.equal(opened.rules.defaults.dm, 2);
  assert.equal(
    opened.rules.defaults.message,
    defaultRulesConfig().rules.defaults.message,
    "an out-of-range priority falls back to the default",
  );
  assert.equal(opened.rules.users.u1, 4);
  assert.deepEqual(opened.profiles, defaultRulesConfig().profiles);
});

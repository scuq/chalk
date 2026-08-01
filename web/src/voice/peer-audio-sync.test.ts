// 66-3: the sealed "mute for me" list. Same shape of test as the rules blob --
// the failure cases matter more than the happy path, because the blob comes
// from the server, which is untrusted by design. Anything but a clean decrypt
// of a known version has to come back null so the caller keeps the local list.
//
// Plus the normalizer, which is the other untrusted edge: the decrypted
// plaintext was written by another device and lands straight in front of the
// volume sliders.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openPeerAudioStore,
  peerAudioAesKey,
  sealPeerAudioStore,
} from "./peer-audio-sync.ts";
import {
  isDefaultPeerAudioPref,
  normalizePeerAudioPref,
  normalizePeerAudioStore,
} from "./peer-audio-store.ts";
import { rulesAesKey } from "../notify/rules-sync.ts";

const SCALAR = new Uint8Array(32).fill(7);
const OTHER_SCALAR = new Uint8Array(32).fill(8);

const STORE = {
  "chan-1": { "user-a": { muted: true, volume: 1 }, "user-b": { muted: false, volume: 0.4 } },
  "chan-2": { "user-a": { muted: true, volume: 0.8 } },
};

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

test("a list round-trips through seal and open", async () => {
  const key = await peerAudioAesKey(SCALAR);
  const opened = await openPeerAudioStore(key, await sealPeerAudioStore(key, STORE));
  assert.deepEqual(opened, STORE);
});

test("the key derivation is deterministic -- two devices, same key", async () => {
  // Seal on "device A", open on "device B" from the same scalar. This IS the
  // sync property.
  const a = await peerAudioAesKey(SCALAR);
  const b = await peerAudioAesKey(SCALAR);
  assert.deepEqual(await openPeerAudioStore(b, await sealPeerAudioStore(a, STORE)), STORE);
});

test("the rules key cannot open a peer-audio blob", async () => {
  // Independent salt/info per blob: one derived key must not read the other's
  // data even though both come from the same identity scalar.
  const mine = await peerAudioAesKey(SCALAR);
  const rules = await rulesAesKey(SCALAR);
  assert.equal(await openPeerAudioStore(rules, await sealPeerAudioStore(mine, STORE)), null);
});

test("a tampered blob opens as null", async () => {
  const key = await peerAudioAesKey(SCALAR);
  const bytes = b64decode(await sealPeerAudioStore(key, STORE));
  bytes[bytes.length - 5] ^= 0xff;
  assert.equal(await openPeerAudioStore(key, b64encode(bytes)), null);
});

test("the wrong key opens as null", async () => {
  const key = await peerAudioAesKey(SCALAR);
  const other = await peerAudioAesKey(OTHER_SCALAR);
  assert.equal(await openPeerAudioStore(other, await sealPeerAudioStore(key, STORE)), null);
});

test("garbage input opens as null, never throws", async () => {
  const key = await peerAudioAesKey(SCALAR);
  assert.equal(await openPeerAudioStore(key, ""), null);
  assert.equal(await openPeerAudioStore(key, "not base64 at all!!"), null);
  assert.equal(await openPeerAudioStore(key, b64encode(new Uint8Array(4))), null);
});

test("normalizePeerAudioPref clamps and defaults", () => {
  assert.deepEqual(normalizePeerAudioPref(undefined), { muted: false, volume: 1 });
  assert.deepEqual(normalizePeerAudioPref({ volume: 2 }), { muted: false, volume: 1 });
  assert.deepEqual(normalizePeerAudioPref({ volume: -1 }), { muted: false, volume: 0 });
  // A NaN volume would silence someone permanently: element.volume = NaN
  // throws, so the slider would be stuck. Falls back to full.
  assert.deepEqual(normalizePeerAudioPref({ volume: NaN }), { muted: false, volume: 1 });
  assert.deepEqual(normalizePeerAudioPref({ muted: 1 } as never), { muted: true, volume: 1 });
});

test("isDefaultPeerAudioPref spots the rows worth dropping", () => {
  assert.equal(isDefaultPeerAudioPref({ muted: false, volume: 1 }), true);
  assert.equal(isDefaultPeerAudioPref({ muted: true, volume: 1 }), false);
  assert.equal(isDefaultPeerAudioPref({ muted: false, volume: 0.5 }), false);
});

test("normalizePeerAudioStore is total over junk", () => {
  assert.deepEqual(normalizePeerAudioStore(undefined), {});
  assert.deepEqual(normalizePeerAudioStore(null), {});
  assert.deepEqual(normalizePeerAudioStore("nope"), {});
  assert.deepEqual(normalizePeerAudioStore([1, 2]), {});
  assert.deepEqual(normalizePeerAudioStore({ "chan-1": "nope" }), {});
  assert.deepEqual(normalizePeerAudioStore({ "chan-1": { "user-a": 7 } }), {});
});

test("normalizePeerAudioStore drops default rows and empty rooms", () => {
  assert.deepEqual(
    normalizePeerAudioStore({
      "chan-1": { "user-a": { muted: false, volume: 1 }, "user-b": { muted: true } },
      "chan-2": { "user-c": { muted: false, volume: 1 } },
    }),
    { "chan-1": { "user-b": { muted: true, volume: 1 } } },
  );
});

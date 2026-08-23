// 84-1: the pin backup blob and, mostly, the merge.
//
// The sealing cases mirror rules-sync.test.ts -- the blob comes back through an
// untrusted server, so every way of being wrong has to be null rather than a
// throw. The merge cases are the ones that carry weight: they are the
// difference between a backup that restores the user's trust decisions and one
// that quietly launders a substituted key into the device that would have
// caught it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOB_BUDGET_BYTES,
  choosePin,
  fitPins,
  mergePins,
  openPins,
  packPin,
  pinsAesKey,
  sealPins,
  unpackPins,
} from "./pin-backup.ts";
import type { VerificationRecord } from "./safety-number.ts";

const SCALAR = new Uint8Array(32).fill(7);
const OTHER_SCALAR = new Uint8Array(32).fill(8);
const OWN_PUB = new Uint8Array(32).fill(1);

const KEY_A = "AAAA" + "A".repeat(40);
const KEY_B = "BBBB" + "B".repeat(40);

function tofu(peer: string, key: string, pinnedAt: number): VerificationRecord {
  return {
    peerUserID: peer,
    digestHex: "",
    generation: 1,
    verifiedAt: 0,
    ed25519PubB64: key,
    source: "tofu",
    pinnedAt,
  };
}

function manual(peer: string, key: string, verifiedAt: number): VerificationRecord {
  return {
    peerUserID: peer,
    digestHex: "ab".repeat(32),
    generation: 1,
    verifiedAt,
    ed25519PubB64: key,
    source: "manual",
    pinnedAt: verifiedAt,
  };
}

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

// ---- the merge ---------------------------------------------------------

test("a device with no pins restores the whole set -- this is the point", () => {
  const remote = [tofu("bob", KEY_A, 1000), manual("carol", KEY_B, 2000)];
  const r = mergePins([], remote);
  assert.equal(r.merged.length, 2);
  assert.deepEqual(r.restored.sort(), ["bob", "carol"]);
  assert.ok(r.writes.length > 0);
});

test("a conflicting key from another device does NOT overwrite an older pin", () => {
  // The laundering case: a fresh device was served a substituted key and
  // pinned it (nothing to compare against). It must not win here.
  const local = [tofu("bob", KEY_A, 1000)];
  const remote = [tofu("bob", KEY_B, 5000)];
  const r = mergePins(local, remote);
  assert.equal(r.merged.length, 1);
  assert.equal(r.merged[0].ed25519PubB64, KEY_A);
  assert.deepEqual(r.conflicts, ["bob"]);
  assert.deepEqual(r.writes, []);
});

test("the merge is symmetric, so two devices converge instead of ping-ponging", () => {
  const a = [tofu("bob", KEY_A, 1000)];
  const b = [tofu("bob", KEY_B, 5000)];
  const fromA = mergePins(a, b).merged;
  const fromB = mergePins(b, a).merged;
  assert.equal(fromA[0].ed25519PubB64, fromB[0].ed25519PubB64);
});

test("an out-of-band comparison overturns a plain sighting", () => {
  // The escape hatch: a peer really did reinstall, and the user compared the
  // new number in person on their phone. That has to reach the laptop.
  const local = [tofu("bob", KEY_A, 1000)];
  const remote = [manual("bob", KEY_B, 9000)];
  const r = mergePins(local, remote);
  assert.equal(r.merged[0].ed25519PubB64, KEY_B);
  assert.equal(r.merged[0].verifiedAt, 9000);
  assert.ok(r.writes.length > 0);
});

test("a sighting never overturns a comparison, however recent", () => {
  const local = [manual("bob", KEY_A, 1000)];
  const remote = [tofu("bob", KEY_B, 9999)];
  const r = mergePins(local, remote);
  assert.equal(r.merged[0].ed25519PubB64, KEY_A);
  assert.deepEqual(r.conflicts, ["bob"]);
});

test("the same key from both sides keeps the stronger provenance", () => {
  const local = [tofu("bob", KEY_A, 5000)];
  const remote = [manual("bob", KEY_A, 7000)];
  const r = mergePins(local, remote);
  assert.equal(r.merged[0].source, "manual");
  assert.equal(r.merged[0].verifiedAt, 7000);
  // Earliest sighting is the anchor, so it survives the upgrade.
  assert.equal(r.merged[0].pinnedAt, 5000);
  assert.ok(r.writes.length > 0);
});

test("a merge that adds nothing writes nothing", () => {
  const local = [tofu("bob", KEY_A, 1000)];
  const r = mergePins(local, [tofu("bob", KEY_A, 1000)]);
  assert.deepEqual(r.writes, []);
  assert.deepEqual(r.conflicts, []);
});

test("choosePin prefers the earlier sighting when neither was compared", () => {
  const early = tofu("bob", KEY_A, 100);
  const late = tofu("bob", KEY_B, 900);
  assert.equal(choosePin(late, early).ed25519PubB64, KEY_A);
  assert.equal(choosePin(early, late).ed25519PubB64, KEY_A);
});

// ---- packing -----------------------------------------------------------

test("a pin with a key packs without its digest -- the digest is derivable", () => {
  const packed = packPin(manual("bob", KEY_A, 4000));
  assert.equal(packed.length, 5);
  assert.equal(packed[3], 4); // seconds, not milliseconds
});

test("a pre-82 record with no key keeps its digest", () => {
  const legacy: VerificationRecord = {
    peerUserID: "bob",
    digestHex: "cd".repeat(32),
    generation: 2,
    verifiedAt: 5000,
  };
  const packed = packPin(legacy);
  assert.equal(packed.length, 6);
  assert.equal(packed[5], "cd".repeat(32));
});

test("unpackPins rejects a malformed blob rather than salvaging part of it", () => {
  assert.equal(unpackPins(null), null);
  assert.equal(unpackPins({ v: 99, pins: [] }), null);
  assert.equal(unpackPins({ v: 1, pins: "nope" }), null);
  assert.equal(unpackPins({ v: 1, pins: [["bob"]] }), null);
  assert.equal(unpackPins({ v: 1, pins: [["bob", "", 1, 2, 3]] }), null, "no key and no digest");
  assert.deepEqual(unpackPins({ v: 1, pins: [] }), []);
});

// ---- capacity ----------------------------------------------------------

test("overflow drops sightings before comparisons", () => {
  const records: VerificationRecord[] = [];
  for (let i = 0; i < 200; i++) records.push(tofu(`peer-${i}-${"x".repeat(20)}`, KEY_A, 1000 + i));
  records.push(manual("verified-peer", KEY_B, 10));
  const { kept, dropped } = fitPins(records);
  assert.ok(dropped.length > 0, "200 peers must not fit in one prefs patch");
  assert.equal(kept[0].peerUserID, "verified-peer");
  assert.ok(dropped.every((r) => r.verifiedAt === 0));
});

test("what fitPins keeps actually seals within the budget", async () => {
  const records: VerificationRecord[] = [];
  for (let i = 0; i < 200; i++) {
    records.push(tofu(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, KEY_A, 1000 + i));
  }
  const { kept } = fitPins(records);
  const key = await pinsAesKey(SCALAR);
  const blob = await sealPins(key, kept);
  assert.ok(blob.length <= BLOB_BUDGET_BYTES, `blob was ${blob.length}`);
});

// ---- sealing -----------------------------------------------------------

test("pins round-trip through seal and open", async () => {
  const key = await pinsAesKey(SCALAR);
  const peerPub = new Uint8Array(32).fill(3);
  const pinned = b64encode(peerPub);
  const records = [tofu("bob", pinned, 4000), manual("carol", pinned, 8000)];
  const opened = await openPins(key, await sealPins(key, records), OWN_PUB);
  assert.equal(opened?.length, 2);
  assert.equal(opened?.[0].ed25519PubB64, pinned);
  assert.equal(opened?.[0].pinnedAt, 4000);
  assert.equal(opened?.[0].verifiedAt, 0);
  assert.equal(opened?.[0].source, "tofu");
  assert.equal(opened?.[0].digestHex, "", "a sighting has no compared digest");
  assert.equal(opened?.[1].source, "manual");
  assert.equal(opened?.[1].digestHex.length, 64, "a comparison's digest is recomputed");
});

test("the key derivation is deterministic -- two devices, same key", async () => {
  const a = await pinsAesKey(SCALAR);
  const b = await pinsAesKey(SCALAR);
  const records = [tofu("bob", b64encode(new Uint8Array(32).fill(3)), 4000)];
  const opened = await openPins(b, await sealPins(a, records), OWN_PUB);
  assert.equal(opened?.length, 1);
});

test("a tampered blob opens as null", async () => {
  const key = await pinsAesKey(SCALAR);
  const blob = await sealPins(key, [tofu("bob", KEY_A, 1)]);
  const bytes = b64decode(blob);
  bytes[bytes.length - 5] ^= 0xff;
  assert.equal(await openPins(key, b64encode(bytes), OWN_PUB), null);
});

test("the wrong key opens as null", async () => {
  const key = await pinsAesKey(SCALAR);
  const other = await pinsAesKey(OTHER_SCALAR);
  const blob = await sealPins(key, [tofu("bob", KEY_A, 1)]);
  assert.equal(await openPins(other, blob, OWN_PUB), null);
});

test("garbage input opens as null, never throws", async () => {
  const key = await pinsAesKey(SCALAR);
  assert.equal(await openPins(key, "", OWN_PUB), null);
  assert.equal(await openPins(key, "!!not base64!!", OWN_PUB), null);
  assert.equal(await openPins(key, b64encode(new Uint8Array(40)), OWN_PUB), null);
});

test("a pin whose key will not decode is dropped, not kept as a keyless one", async () => {
  const key = await pinsAesKey(SCALAR);
  const blob = await sealPins(key, [tofu("bob", "AAAA", 1000)]);
  assert.deepEqual(await openPins(key, blob, OWN_PUB), []);
});

// ---- 83-6: the server pin in the blob ------------------------------------

import { sealPins as sealPins836, openPinBlob, chooseServerPin, unpackServerPin, pinsAesKey as key836 } from "./pin-backup";

test("83-6: the server pin rides the sealed blob and comes back intact", async () => {
  const key = await key836(new Uint8Array(32).fill(5));
  const own = new Uint8Array(32).fill(9);
  const srv: import("./pin-backup").PackedServerPin = ["QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=", "registration", 1754730000];
  const blob = await sealPins836(key, [], srv);
  const opened = await openPinBlob(key, blob, own);
  assert.ok(opened);
  assert.deepEqual(opened!.serverPin, srv);
  // a blob without one opens with null (older builds)
  const legacy = await sealPins836(key, []);
  assert.equal((await openPinBlob(key, legacy, own))!.serverPin, null);
});

test("83-6: chooseServerPin ranks registration > repin > tofu, then first sight", () => {
  const reg: import("./pin-backup").PackedServerPin = ["QQ==", "registration", 2000];
  const tofu: import("./pin-backup").PackedServerPin = ["Qg==", "tofu", 1000];
  const repin: import("./pin-backup").PackedServerPin = ["Qw==", "repin", 1500];
  assert.equal(chooseServerPin(tofu, reg), reg); // the backup's anchor beats a fresh TOFU
  assert.equal(chooseServerPin(repin, tofu), repin);
  assert.equal(chooseServerPin(reg, repin), reg);
  const regLater: import("./pin-backup").PackedServerPin = ["RA==", "registration", 3000];
  assert.equal(chooseServerPin(regLater, reg), reg); // equal rank: earlier wins
  assert.equal(chooseServerPin(null, tofu), tofu);
  assert.equal(chooseServerPin(reg, null), reg);
});

test("83-6: unpackServerPin is total over garbage", () => {
  assert.equal(unpackServerPin(null), null);
  assert.equal(unpackServerPin({ v: 1, pins: [] }), null);
  assert.equal(unpackServerPin({ v: 1, pins: [], srv: ["x", "registration", 1] }), null); // not 32 bytes
  assert.equal(unpackServerPin({ v: 1, pins: [], srv: ["QUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE=", "bogus", 1] }), null);
});

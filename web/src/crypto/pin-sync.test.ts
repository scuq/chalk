// 84-2: the sync loop. What is asserted here is the behaviour that separates
// this from the rules blob it is modelled on -- a device that lost its storage
// must LEARN from the backup without publishing its own emptiness over it, and
// two devices that agree must go quiet instead of trading fresh ciphertext for
// the same content forever.

import { test } from "node:test";
import assert from "node:assert/strict";
import { PinSync, type PinStorage } from "./pin-sync.ts";
import { PINS_PREFS_KEY } from "./pin-backup.ts";
import type { VerificationRecord } from "./safety-number.ts";

const OWN_PUB = new Uint8Array(32).fill(1);

function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

const KEY_A = b64encode(new Uint8Array(32).fill(3));
const KEY_B = b64encode(new Uint8Array(32).fill(4));

function pin(peer: string, key: string, pinnedAt: number): VerificationRecord {
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

function verified(peer: string, key: string, verifiedAt: number): VerificationRecord {
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

/**
 * The identity every device in a test shares -- PinSync derives its AES key
 * from this scalar, so "two devices of the same user" means one of these.
 */
async function identity(): Promise<CryptoKey> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return pair.privateKey;
}

interface FakeStorage extends PinStorage {
  records: Map<string, VerificationRecord>;
}

function fakeStorage(initial: VerificationRecord[] = []): FakeStorage {
  const records = new Map(initial.map((r) => [r.peerUserID, r]));
  const listeners = new Set<() => void>();
  return {
    records,
    list: async () => [...records.values()],
    save: async (r) => {
      records.set(r.peerUserID, r);
      for (const fn of listeners) fn();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

function fakeTransport() {
  const sent: Record<string, unknown>[] = [];
  return { sent, send: (patch: Record<string, unknown>) => void sent.push(patch) };
}

/** A device: its own storage and transport, sharing the user's identity. */
async function device(id: CryptoKey, initial: VerificationRecord[] = []) {
  const storage = fakeStorage(initial);
  const transport = fakeTransport();
  const sync = new PinSync();
  await sync.start(id, OWN_PUB, transport, storage);
  return {
    storage,
    transport,
    sync,
    /** The blob this device last uploaded. */
    lastBlob: () => transport.sent.at(-1)?.[PINS_PREFS_KEY] as string | undefined,
  };
}

test("a wiped device restores the whole set from the backup", async () => {
  const id = await identity();
  const old = await device(id, [pin("bob", KEY_A, 1000), verified("carol", KEY_B, 2000)]);
  await old.sync.push();

  const wiped = await device(id);
  await wiped.sync.applyRemote(old.lastBlob());

  assert.equal(wiped.storage.records.size, 2);
  assert.equal(wiped.storage.records.get("bob")?.ed25519PubB64, KEY_A);
  assert.equal(wiped.storage.records.get("carol")?.verifiedAt, 2000);
  old.sync.stop();
  wiped.sync.stop();
});

test("a wiped device does not publish its emptiness over the backup", async () => {
  const id = await identity();
  const old = await device(id, [pin("bob", KEY_A, 1000)]);
  await old.sync.push();

  const wiped = await device(id);
  await wiped.sync.applyRemote(old.lastBlob());

  // Having learned the same set, it has nothing new to say.
  assert.equal(wiped.transport.sent.length, 0);
  old.sync.stop();
  wiped.sync.stop();
});

test("a device that knew more publishes the union", async () => {
  const id = await identity();
  const a = await device(id, [pin("bob", KEY_A, 1000)]);
  await a.sync.push();

  const b = await device(id, [pin("dave", KEY_B, 3000)]);
  await b.sync.applyRemote(a.lastBlob());

  assert.equal(b.storage.records.size, 2);
  assert.equal(b.transport.sent.length, 1, "b knew dave, so it must upload");

  // And a, fed that blob back, converges without another round.
  await a.sync.applyRemote(b.lastBlob());
  assert.equal(a.storage.records.size, 2);
  assert.equal(a.transport.sent.length, 1);
  a.sync.stop();
  b.sync.stop();
});

test("an unreadable blob leaves local pins alone", async () => {
  const d = await device(await identity(), [pin("bob", KEY_A, 1000)]);

  await d.sync.applyRemote("!!!not a blob!!!");

  assert.equal(d.storage.records.size, 1);
  assert.equal(d.storage.records.get("bob")?.ed25519PubB64, KEY_A);
  assert.equal(d.transport.sent.length, 0, "an unreadable backup must not be overwritten");
  d.sync.stop();
});

test("a server holding no blob yet gets seeded from this device", async () => {
  const d = await device(await identity(), [pin("bob", KEY_A, 1000)]);

  await d.sync.applyRemote(undefined);

  assert.equal(d.transport.sent.length, 1);
  d.sync.stop();
});

test("re-publishing an unchanged set sends nothing -- content, not ciphertext", async () => {
  const d = await device(await identity(), [pin("bob", KEY_A, 1000)]);

  await d.sync.push();
  await d.sync.push();
  await d.sync.push();

  assert.equal(d.transport.sent.length, 1, "every seal draws a new nonce; only content counts");
  d.sync.stop();
});

test("echoing back our own blob does not start a new round", async () => {
  const d = await device(await identity(), [pin("bob", KEY_A, 1000)]);

  await d.sync.push();
  await d.sync.applyRemote(d.lastBlob());

  assert.equal(d.transport.sent.length, 1);
  d.sync.stop();
});

test("a new local pin is published on the next push", async () => {
  const d = await device(await identity(), [pin("bob", KEY_A, 1000)]);

  await d.sync.push();
  await d.storage.save(pin("carol", KEY_B, 2000));
  await d.sync.push();

  assert.equal(d.transport.sent.length, 2);
  d.sync.stop();
});

test("a conflicting backup neither overwrites local nor loops", async () => {
  const id = await identity();
  const attacked = await device(id, [pin("bob", KEY_B, 9000)]); // later, different key
  await attacked.sync.push();

  const anchored = await device(id, [pin("bob", KEY_A, 1000)]); // the earlier sighting
  await anchored.sync.applyRemote(attacked.lastBlob());

  assert.equal(anchored.storage.records.get("bob")?.ed25519PubB64, KEY_A);
  // It publishes its own answer once; feeding that back settles it.
  const settled = anchored.transport.sent.length;
  await anchored.sync.applyRemote(anchored.lastBlob());
  assert.equal(anchored.transport.sent.length, settled);
  attacked.sync.stop();
  anchored.sync.stop();
});

test("status reports what is held versus what is backed up", async () => {
  const storage = fakeStorage([pin("bob", KEY_A, 1000)]);
  const transport = fakeTransport();
  const sync = new PinSync();
  let held = 0;
  let backedUp = 0;
  await sync.start(await identity(), OWN_PUB, transport, storage, (s) => {
    held = s.held;
    backedUp = s.backedUp;
  });

  await sync.push();

  assert.equal(held, 1);
  assert.equal(backedUp, 1);
  sync.stop();
});

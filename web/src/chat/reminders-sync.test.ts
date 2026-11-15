// 87-2: tests for the sealed blob and for RemindersSync. Each device in a test has
// its own fake store, and the tests pass blobs between the devices by hand.

import { test } from "node:test";
import assert from "node:assert/strict";
import { blobKey, sealJSON } from "../crypto/prefs-blob.ts";
import { DONE_KEEP_MS, REMINDERS_VERSION, packReminder, type Reminder } from "./reminders.ts";
import {
  REMINDERS_PREFS_KEY,
  RemindersSync,
  openReminders,
  remindersAesKey,
  sealReminders,
  type RemindersStorage,
} from "./reminders-sync.ts";

const SCALAR = new Uint8Array(32).fill(7);
const OTHER_SCALAR = new Uint8Array(32).fill(8);
// A fixed clock. The sync takes it as a parameter, so no test needs fake timers.
const NOW = new Date(2026, 10, 20, 12).getTime();

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function rem(n: number, over: Partial<Reminder> = {}): Reminder {
  return {
    id: uuid(n),
    channelID: uuid(900),
    messageID: uuid(1000 + n),
    messageTS: NOW - 1000,
    seq: 40 + n,
    dueAt: NOW + 3_600_000 + n,
    createdAt: NOW - 500,
    updatedAt: NOW - 500,
    firedAt: null,
    doneAt: null,
    ...over,
  };
}

async function identity(): Promise<CryptoKey> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  return pair.privateKey;
}

interface FakeStorage extends RemindersStorage {
  current: Reminder[];
  saves: number;
}

function fakeStorage(initial: Reminder[] = []): FakeStorage {
  const listeners = new Set<() => void>();
  const s: FakeStorage = {
    current: [...initial],
    saves: 0,
    list: () => [...s.current],
    save: (list) => {
      s.current = [...list];
      s.saves++;
      for (const fn of listeners) fn();
    },
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return s;
}

async function device(id: CryptoKey, initial: Reminder[] = []) {
  const storage = fakeStorage(initial);
  const sent: string[] = [];
  // link.open switches the fake socket. When it is false, send reports false.
  const link = { open: true };
  const sync = new RemindersSync();
  await sync.start(
    id,
    {
      send: (patch) => {
        if (!link.open) return false;
        sent.push(patch[REMINDERS_PREFS_KEY] as string);
        return true;
      },
    },
    storage,
    () => NOW,
  );
  return { sync, storage, sent, link, lastBlob: () => sent[sent.length - 1] };
}

function ids(list: Reminder[]): string[] {
  return list.map((r) => r.id).sort();
}

test("a set round-trips through seal and open", async () => {
  const key = await remindersAesKey(SCALAR);
  const set = [rem(1, { preview: "héllo" }), rem(2, { seq: null, doneAt: NOW })];
  assert.deepEqual(await openReminders(key, await sealReminders(key, set)), set);
});

test("the key derivation is deterministic -- two devices, same key", async () => {
  const a = await remindersAesKey(SCALAR);
  const b = await remindersAesKey(SCALAR);
  assert.deepEqual(await openReminders(b, await sealReminders(a, [rem(1)])), [rem(1)]);
});

test("a tampered blob opens as null", async () => {
  const key = await remindersAesKey(SCALAR);
  const blob = await sealReminders(key, [rem(1)]);
  const flipped = blob.slice(0, 20) + (blob[20] === "A" ? "B" : "A") + blob.slice(21);
  assert.equal(await openReminders(key, flipped), null);
});

test("the wrong key opens as null", async () => {
  const blob = await sealReminders(await remindersAesKey(SCALAR), [rem(1)]);
  assert.equal(await openReminders(await remindersAesKey(OTHER_SCALAR), blob), null);
});

test("another blob's key cannot open a reminders blob", async () => {
  const blob = await sealReminders(await remindersAesKey(SCALAR), [rem(1)]);
  const rulesKey = await blobKey(SCALAR, "chalk-notify-rules-salt-v1", "chalk-notify-rules-v1");
  assert.equal(await openReminders(rulesKey, blob), null);
});

test("garbage input opens as null, never throws", async () => {
  const key = await remindersAesKey(SCALAR);
  for (const blob of ["", "!!!", "AAAA", "x".repeat(200)]) {
    assert.equal(await openReminders(key, blob), null);
  }
});

test("an unknown version or a wrong shape opens as null", async () => {
  const key = await remindersAesKey(SCALAR);
  const rows = [packReminder(rem(1))];
  const cases: unknown[] = [
    { v: REMINDERS_VERSION + 1, reminders: rows },
    { v: REMINDERS_VERSION, reminders: "x" },
    { v: REMINDERS_VERSION },
    [],
    7,
    null,
  ];
  for (const value of cases) {
    assert.equal(await openReminders(key, await sealJSON(key, value)), null);
  }
});

test("a wiped device restores the whole set from the blob", async () => {
  const id = await identity();
  const a = await device(id, [rem(1), rem(2)]);
  await a.sync.push();
  const b = await device(id);
  await b.sync.applyRemote(a.lastBlob());
  assert.deepEqual(ids(b.storage.current), ids([rem(1), rem(2)]));
  a.sync.stop();
  b.sync.stop();
});

test("a wiped device does not publish its emptiness over the blob", async () => {
  const id = await identity();
  const a = await device(id, [rem(1)]);
  await a.sync.push();
  const b = await device(id);
  await b.sync.applyRemote(a.lastBlob());
  assert.equal(b.sent.length, 0);
  a.sync.stop();
  b.sync.stop();
});

test("a device that knew more publishes the union", async () => {
  const id = await identity();
  const a = await device(id, [rem(1)]);
  await a.sync.push();
  const b = await device(id, [rem(2)]);
  await b.sync.applyRemote(a.lastBlob());
  assert.equal(b.sent.length, 1);
  await a.sync.applyRemote(b.lastBlob());
  assert.deepEqual(ids(a.storage.current), ids([rem(1), rem(2)]));
  assert.equal(a.sent.length, 1);
  a.sync.stop();
  b.sync.stop();
});

test("done on one device clears on the other and is not resurrected", async () => {
  const id = await identity();
  const a = await device(id, [rem(1)]);
  await a.sync.push();
  const b = await device(id);
  await b.sync.applyRemote(a.lastBlob());

  b.storage.save([rem(1, { doneAt: NOW, updatedAt: NOW })]);
  await b.sync.push();
  await a.sync.applyRemote(b.lastBlob());
  assert.equal(a.storage.current[0].doneAt, NOW);
  assert.equal(a.sent.length, 1);
  a.sync.stop();
  b.sync.stop();
});

test("an unreadable blob leaves the local set alone and sends nothing", async () => {
  const id = await identity();
  const a = await device(id, [rem(1)]);
  await a.sync.applyRemote("not-a-blob");
  assert.deepEqual(a.storage.current, [rem(1)]);
  assert.equal(a.storage.saves, 0);
  assert.equal(a.sent.length, 0);
  a.sync.stop();
});

test("a server holding no blob yet gets seeded from this device", async () => {
  const id = await identity();
  const a = await device(id, [rem(1)]);
  await a.sync.applyRemote(undefined);
  assert.equal(a.sent.length, 1);
  const key = await remindersAesKey(new Uint8Array(32));
  assert.equal(await openReminders(key, a.lastBlob()), null);
  a.sync.stop();
});

test("re-publishing an unchanged set sends nothing -- content, not ciphertext", async () => {
  const id = await identity();
  const a = await device(id, [rem(1)]);
  await a.sync.push();
  await a.sync.push();
  assert.equal(a.sent.length, 1);
  a.sync.stop();
});

test("echoing back our own blob does not start a new round", async () => {
  const id = await identity();
  const a = await device(id, [rem(1)]);
  await a.sync.push();
  await a.sync.applyRemote(a.lastBlob());
  assert.equal(a.sent.length, 1);
  assert.equal(a.storage.saves, 0);
  a.sync.stop();
});

test("a new local reminder is published on the next push", async () => {
  const id = await identity();
  const a = await device(id, [rem(1)]);
  await a.sync.push();
  a.storage.save([rem(1), rem(2)]);
  await a.sync.push();
  assert.equal(a.sent.length, 2);
  a.sync.stop();
});

test("a send on a closed socket is not counted as sent", async () => {
  const id = await identity();
  const a = await device(id, [rem(1)]);
  a.link.open = false;
  await a.sync.push();
  assert.equal(a.sent.length, 0);
  a.link.open = true;
  await a.sync.push();
  assert.equal(a.sent.length, 1);
  a.sync.stop();
});

test("push prunes old done records from the local set and the blob", async () => {
  const id = await identity();
  const old = rem(1, { doneAt: NOW - DONE_KEEP_MS - 1 });
  const a = await device(id, [old, rem(2)]);
  await a.sync.push();
  assert.deepEqual(ids(a.storage.current), ids([rem(2)]));
  const b = await device(id);
  await b.sync.applyRemote(a.lastBlob());
  assert.deepEqual(ids(b.storage.current), ids([rem(2)]));
  a.sync.stop();
  b.sync.stop();
});

test("a stopped sync ignores a blob and a push", async () => {
  const id = await identity();
  const a = await device(id, [rem(1)]);
  await a.sync.push();
  const blob = a.lastBlob();
  const b = await device(id);
  b.sync.stop();
  await b.sync.applyRemote(blob);
  await b.sync.push();
  assert.equal(b.storage.saves, 0);
  assert.equal(b.sent.length, 0);
  a.sync.stop();
});

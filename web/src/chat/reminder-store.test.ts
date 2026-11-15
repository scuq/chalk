// 87-2: tests for the local reminder store, with a fake localStorage.

import { test } from "node:test";
import assert from "node:assert/strict";
import { packReminder, type Reminder } from "./reminders.ts";
import {
  clearReminders,
  loadReminders,
  reminderStorageKey,
  saveReminders,
  subscribeReminders,
} from "./reminder-store.ts";

const items = new Map<string, string>();
const storageHandlers = new Set<(e: { key: string | null }) => void>();
let failWrites = false;

// The store reads the global `window`. This fake holds localStorage in a map and
// keeps the `storage` handlers, so a test can call them as another tab would.
// failWrites makes setItem throw, as a full quota does.
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrites) throw new Error("quota");
      items.set(k, v);
    },
    removeItem: (k: string) => {
      items.delete(k);
    },
  },
  addEventListener: (type: string, fn: (e: { key: string | null }) => void) => {
    if (type === "storage") storageHandlers.add(fn);
  },
  removeEventListener: (type: string, fn: (e: { key: string | null }) => void) => {
    if (type === "storage") storageHandlers.delete(fn);
  },
};

function rem(n: number, over: Partial<Reminder> = {}): Reminder {
  return {
    id: `r${n}`,
    channelID: "c1",
    messageID: `m${n}`,
    messageTS: 1000,
    seq: n,
    dueAt: 5000 + n,
    createdAt: 2000,
    updatedAt: 2000,
    firedAt: null,
    doneAt: null,
    ...over,
  };
}

test("an unknown user has an empty set", () => {
  assert.deepEqual(loadReminders("nobody"), []);
});

test("load reads the packed form from localStorage", () => {
  items.set(reminderStorageKey("u-read"), JSON.stringify([packReminder(rem(1))]));
  assert.deepEqual(loadReminders("u-read"), [rem(1)]);
});

test("corrupt storage loads as an empty set", () => {
  items.set(reminderStorageKey("u-bad"), "{not json");
  assert.deepEqual(loadReminders("u-bad"), []);
  items.set(reminderStorageKey("u-shape"), JSON.stringify({ a: 1 }));
  assert.deepEqual(loadReminders("u-shape"), []);
});

test("save writes the packed form and load returns it", () => {
  saveReminders("u-save", [rem(1, { preview: "hi" }), rem(2)]);
  assert.deepEqual(JSON.parse(items.get(reminderStorageKey("u-save")) ?? ""), [
    packReminder(rem(1, { preview: "hi" })),
    packReminder(rem(2)),
  ]);
  assert.deepEqual(loadReminders("u-save"), [rem(1, { preview: "hi" }), rem(2)]);
});

test("each user has a separate set", () => {
  saveReminders("u-a", [rem(1)]);
  saveReminders("u-b", [rem(2)]);
  assert.deepEqual(loadReminders("u-a"), [rem(1)]);
  assert.deepEqual(loadReminders("u-b"), [rem(2)]);
});

test("a caller cannot change the stored set through the returned list", () => {
  saveReminders("u-copy", [rem(1)]);
  loadReminders("u-copy").push(rem(2));
  assert.deepEqual(loadReminders("u-copy"), [rem(1)]);
});

test("a failed write still holds the set for this page load and notifies", () => {
  let calls = 0;
  const unsub = subscribeReminders("u-quota", () => calls++);
  failWrites = true;
  saveReminders("u-quota", [rem(1)]);
  failWrites = false;
  assert.equal(items.has(reminderStorageKey("u-quota")), false);
  assert.deepEqual(loadReminders("u-quota"), [rem(1)]);
  assert.equal(calls, 1);
  unsub();
});

test("subscribe fires for its own user only, and stops after unsubscribe", () => {
  let calls = 0;
  const unsub = subscribeReminders("u-sub", () => calls++);
  saveReminders("u-other", [rem(1)]);
  assert.equal(calls, 0);
  saveReminders("u-sub", [rem(1)]);
  assert.equal(calls, 1);
  unsub();
  saveReminders("u-sub", [rem(2)]);
  assert.equal(calls, 1);
  assert.equal(storageHandlers.size, 0);
});

test("a storage event from another tab reloads the set", () => {
  saveReminders("u-tab", [rem(1)]);
  let calls = 0;
  const unsub = subscribeReminders("u-tab", () => calls++);
  items.set(reminderStorageKey("u-tab"), JSON.stringify([packReminder(rem(2))]));
  for (const fn of storageHandlers) fn({ key: "some.other.key" });
  assert.equal(calls, 0);
  assert.deepEqual(loadReminders("u-tab"), [rem(1)]);
  for (const fn of storageHandlers) fn({ key: reminderStorageKey("u-tab") });
  assert.equal(calls, 1);
  assert.deepEqual(loadReminders("u-tab"), [rem(2)]);
  unsub();
});

test("clear removes the stored set and notifies", () => {
  saveReminders("u-clear", [rem(1)]);
  let calls = 0;
  const unsub = subscribeReminders("u-clear", () => calls++);
  clearReminders("u-clear");
  assert.equal(items.has(reminderStorageKey("u-clear")), false);
  assert.deepEqual(loadReminders("u-clear"), []);
  assert.equal(calls, 1);
  unsub();
});

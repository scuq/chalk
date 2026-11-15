// chalk-web -- 87-7: tests for the wake set (reminder-wake.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { wakeKey, wakeSet } from "./reminder-wake.ts";
import type { Reminder } from "./reminders.ts";

function rem(id: string, over: Partial<Reminder> = {}): Reminder {
  return {
    id,
    channelID: "c1",
    messageID: `m-${id}`,
    messageTS: 1000,
    seq: 7,
    dueAt: 5000,
    createdAt: 2000,
    updatedAt: 2000,
    firedAt: null,
    doneAt: null,
    preview: "secret text",
    ...over,
  };
}

test("wakeSet: only pending reminders, and only the ID and the due time", () => {
  const set = wakeSet(
    [
    rem("b", { dueAt: 9000 }),
    rem("a"),
    rem("fired", { firedAt: 5001 }),
    rem("done", { doneAt: 5002 }),
    rem("overdue", { dueAt: 4000 }),
    ],
    4000,
  );
  assert.deepEqual(set, [
    { id: "a", due_at: 5000 },
    { id: "b", due_at: 9000 },
  ]);
  assert.deepEqual(wakeSet([], 0), []);
});

test("wakeKey: equal for one set in two orders, different after a snooze", () => {
  const a = rem("a");
  const b = rem("b");
  assert.equal(wakeKey(wakeSet([a, b], 0)), wakeKey(wakeSet([b, a], 0)));
  assert.notEqual(wakeKey(wakeSet([a, b], 0)), wakeKey(wakeSet([a, { ...b, dueAt: 7000 }], 0)));
  assert.notEqual(wakeKey(wakeSet([a, b], 0)), wakeKey(wakeSet([a], 0)));
  assert.equal(wakeKey([]), "");
});

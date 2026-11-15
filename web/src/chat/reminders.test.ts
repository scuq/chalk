// chalk-web -- 87-1: tests for the reminder rules (reminders.ts).
//
// Every clock value comes from `new Date(year, month, day, hour)`, which reads
// local time. So the cases give the same result in every timezone of the
// machine that runs them. The calendar is November 2026.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOB_BUDGET_BYTES } from "../crypto/pin-backup.ts";
import {
  DONE_KEEP_MS,
  PREVIEW_MAX,
  REMINDER_MAX,
  canonicalReminders,
  clipPreview,
  dueAtFor,
  dueNow,
  firedCount,
  fitReminders,
  mergeReminders,
  packReminder,
  pendingFor,
  pruneReminders,
  unpackReminders,
  type Reminder,
} from "./reminders.ts";

// Epoch milliseconds of a local time in November 2026. Month index 10 is
// November.
function at(day: number, hour: number, minute = 0): number {
  return new Date(2026, 10, day, hour, minute).getTime();
}

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

// A pending reminder with number `n`. The due time grows with `n`, so two
// reminders never tie. `over` replaces any field.
function rem(n: number, over: Partial<Reminder> = {}): Reminder {
  return {
    id: uuid(n),
    channelID: uuid(900),
    messageID: uuid(1000 + n),
    messageTS: at(10, 12),
    seq: 1234567890,
    dueAt: at(20, 9) + n,
    createdAt: at(11, 15),
    updatedAt: at(11, 15),
    firedAt: null,
    doneAt: null,
    ...over,
  };
}

// The cases below name weekdays. This test fails first if the calendar is
// wrong, so a failure there does not look like a bug in dueAtFor.
test("the calendar the cases assume", () => {
  assert.equal(new Date(at(11, 15)).getDay(), 3);
  assert.equal(new Date(at(13, 15)).getDay(), 5);
  assert.equal(new Date(at(15, 15)).getDay(), 0);
});

test("dueAtFor: each preset from a Wednesday afternoon", () => {
  const now = at(11, 15);
  assert.equal(dueAtFor("this_evening", now), at(11, 18));
  assert.equal(dueAtFor("tomorrow_morning", now), at(12, 9));
  assert.equal(dueAtFor("tomorrow_evening", now), at(12, 18));
  assert.equal(dueAtFor("weekend", now), at(14, 9));
  assert.equal(dueAtFor("next_monday", now), at(16, 9));
});

test("dueAtFor: this evening stops at 18:00", () => {
  assert.equal(dueAtFor("this_evening", at(11, 17, 59)), at(11, 18));
  assert.equal(dueAtFor("this_evening", at(11, 18)), null);
  assert.equal(dueAtFor("this_evening", at(11, 23)), null);
});

test("dueAtFor: weekend from Friday, Saturday and Sunday", () => {
  assert.equal(dueAtFor("weekend", at(13, 23)), at(14, 9));
  assert.equal(dueAtFor("weekend", at(14, 8)), at(21, 9));
  assert.equal(dueAtFor("weekend", at(14, 12)), at(21, 9));
  assert.equal(dueAtFor("weekend", at(15, 12)), at(21, 9));
});

test("dueAtFor: next Monday from Sunday, Monday and Tuesday", () => {
  assert.equal(dueAtFor("next_monday", at(15, 12)), at(16, 9));
  assert.equal(dueAtFor("next_monday", at(16, 8)), at(23, 9));
  assert.equal(dueAtFor("next_monday", at(17, 12)), at(23, 9));
});

test("dueAtFor: tomorrow crosses a month end", () => {
  assert.equal(dueAtFor("tomorrow_morning", at(30, 22)), new Date(2026, 11, 1, 9).getTime());
});

test("dueAtFor: custom must be later than now", () => {
  const now = at(11, 15);
  assert.equal(dueAtFor("custom", now, now + 60_000), now + 60_000);
  assert.equal(dueAtFor("custom", now, now), null);
  assert.equal(dueAtFor("custom", now, now - 1), null);
  assert.equal(dueAtFor("custom", now, Number.NaN), null);
  assert.equal(dueAtFor("custom", now), null);
});

test("clipPreview: one line, at most PREVIEW_MAX code points", () => {
  assert.equal(clipPreview("  a\n\n b\tc  "), "a b c");
  const long = clipPreview("😀".repeat(PREVIEW_MAX + 5));
  assert.equal(Array.from(long).length, PREVIEW_MAX);
  assert.ok(long.endsWith("…"));
  const exact = "x".repeat(PREVIEW_MAX);
  assert.equal(clipPreview(exact), exact);
});

test("mergeReminders: an empty side loses nothing", () => {
  const set = [rem(1), rem(2)];
  assert.deepEqual(mergeReminders(set, []), set);
  assert.deepEqual(mergeReminders([], set), set);
});

test("mergeReminders: the higher updatedAt wins in both directions", () => {
  const old = rem(1);
  const snoozed = rem(1, { dueAt: at(25, 9), updatedAt: old.updatedAt + 1 });
  assert.deepEqual(mergeReminders([old], [snoozed]), [snoozed]);
  assert.deepEqual(mergeReminders([snoozed], [old]), [snoozed]);
});

test("mergeReminders: on a tie the done record wins in both directions", () => {
  const open = rem(1);
  const done = rem(1, { doneAt: at(12, 9) });
  assert.deepEqual(mergeReminders([open], [done]), [done]);
  assert.deepEqual(mergeReminders([done], [open]), [done]);
});

test("mergeReminders: a newer record reopens a done one", () => {
  const done = rem(1, { doneAt: at(12, 9) });
  const later = rem(1, { updatedAt: done.updatedAt + 1 });
  assert.deepEqual(mergeReminders([done], [later]), [later]);
});

test("canonicalReminders: order of the input does not matter", () => {
  const a = rem(1, { preview: "one" });
  const b = rem(2);
  assert.equal(canonicalReminders([a, b]), canonicalReminders([b, a]));
  assert.notEqual(canonicalReminders([a, b]), canonicalReminders([a, rem(2, { doneAt: 1 })]));
});

test("pack and unpack: round trip with and without a preview", () => {
  const set = [rem(1, { preview: "héllo" }), rem(2, { seq: null, firedAt: at(20, 9) })];
  const wire = JSON.parse(JSON.stringify(set.map(packReminder)));
  assert.deepEqual(unpackReminders(wire), set);
});

test("unpackReminders: garbage gives an empty list, a bad row is skipped", () => {
  assert.deepEqual(unpackReminders(null), []);
  assert.deepEqual(unpackReminders("x"), []);
  assert.deepEqual(unpackReminders({ length: 3 }), []);
  const good = packReminder(rem(1));
  const badType = [...good];
  badType[5] = "soon";
  const short = good.slice(0, 9);
  const badPreview = [...good, 7];
  assert.deepEqual(unpackReminders([null, 3, [], badType, short, badPreview, good]), [rem(1)]);
});

test("fitReminders: a set inside the budget is kept whole", () => {
  const set = [rem(1, { preview: "a" }), rem(2, { preview: "b" })];
  const fit = fitReminders(set);
  assert.equal(fit.kept.length, 2);
  assert.equal(fit.dropped.length, 0);
  assert.equal(fit.previewsStripped, 0);
  assert.ok(fit.kept.every((r) => r.preview !== undefined));
});

// The largest shape is a fired record with a preview of PREVIEW_MAX two-byte
// characters. The test shows that REMINDER_MAX records fit when every preview
// is gone, so the cap at the point of setting never meets a set that cannot be
// saved.
test("fitReminders: REMINDER_MAX records of the largest shape fit without previews", () => {
  const set: Reminder[] = [];
  for (let i = 0; i < REMINDER_MAX; i++) {
    set.push(rem(i, { firedAt: at(20, 9), preview: "ü".repeat(PREVIEW_MAX) }));
  }
  const fit = fitReminders(set, BLOB_BUDGET_BYTES);
  assert.equal(fit.kept.length, REMINDER_MAX);
  assert.equal(fit.dropped.length, 0);
  assert.ok(fit.previewsStripped > 0);
});

test("fitReminders: previews go first, from the end of the keep order", () => {
  const fired = rem(1, { firedAt: at(20, 9), preview: "f".repeat(PREVIEW_MAX) });
  const pending = rem(2, { preview: "p".repeat(PREVIEW_MAX) });
  const done = rem(3, { doneAt: at(12, 9), preview: "d".repeat(PREVIEW_MAX) });
  const all = fitReminders([done, pending, fired], 100_000);
  assert.deepEqual(
    all.kept.map((r) => r.id),
    [fired.id, pending.id, done.id],
  );

  // Walk the budget down until the first preview goes. The sealed length grows
  // in steps of four characters, so a step of 4 does not skip a size.
  let budget = 100_000;
  while (fitReminders([done, pending, fired], budget).previewsStripped === 0) budget -= 4;
  const one = fitReminders([done, pending, fired], budget);
  assert.equal(one.previewsStripped, 1);
  assert.equal(one.dropped.length, 0);
  assert.equal(one.kept[2].preview, undefined);
  assert.notEqual(one.kept[0].preview, undefined);
  assert.notEqual(one.kept[1].preview, undefined);
});

test("fitReminders: records drop in the stated order after every preview is gone", () => {
  const fired = rem(1, { firedAt: at(20, 9), preview: "f" });
  const soon = rem(2, { dueAt: at(21, 9) });
  const far = rem(3, { dueAt: at(28, 9) });
  const doneNew = rem(4, { doneAt: at(13, 9) });
  const doneOld = rem(5, { doneAt: at(12, 9) });
  const set = [doneOld, far, doneNew, soon, fired];
  const order = [fired.id, soon.id, far.id, doneNew.id, doneOld.id];

  // Walk the budget down from a size where everything fits to a size where
  // nothing fits. At each budget, the kept and the dropped records together
  // must keep the order of the rule. Each time a record drops, no preview can
  // be left, because previews go before records.
  let budget = 100_000;
  let seen = 5;
  while (seen > 0) {
    const fit = fitReminders(set, budget);
    assert.deepEqual(
      [...fit.kept, ...fit.dropped].map((r) => r.id),
      order,
    );
    if (fit.kept.length < seen) {
      seen = fit.kept.length;
      assert.ok(fit.kept.every((r) => r.preview === undefined));
    }
    budget -= 4;
    // Stops the loop if a bug keeps a record at a budget that no record fits.
    assert.ok(budget > -8);
  }
});

test("pruneReminders: a done record goes after DONE_KEEP_MS", () => {
  const now = at(20, 12);
  const edge = rem(1, { doneAt: now - DONE_KEEP_MS });
  const old = rem(2, { doneAt: now - DONE_KEEP_MS - 1 });
  const open = rem(3, { createdAt: 0, updatedAt: 0 });
  assert.deepEqual(pruneReminders([edge, old, open], now), [edge, open]);
});

test("dueNow, pendingFor and firedCount on a mixed set", () => {
  const now = at(20, 12);
  const due = rem(1, { dueAt: now });
  const later = rem(2, { dueAt: now + 1 });
  const fired = rem(3, { dueAt: now - 5, firedAt: now - 4 });
  const done = rem(4, { dueAt: now - 5, firedAt: now - 4, doneAt: now - 3 });
  const elsewhere = rem(5, { channelID: uuid(901), dueAt: now - 1 });
  const dupe = rem(6, { messageID: later.messageID, dueAt: now + 9 });
  const set = [due, later, fired, done, elsewhere, dupe];

  assert.deepEqual(dueNow(set, now), [due, elsewhere]);
  assert.equal(firedCount(set), 1);

  const marks = pendingFor(set, uuid(900));
  assert.deepEqual([...marks.keys()].sort(), [due.messageID, later.messageID].sort());
  assert.equal(marks.get(later.messageID), later);
});

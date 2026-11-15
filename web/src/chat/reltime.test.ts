// 87-4: tests of fmtUntil. The fixed `now` is a Wednesday, 11 November 2026,
// 15:00 local time. The cases use local-time Date constructors, so they hold in
// any timezone.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fmtUntil } from "./reltime.ts";

const now = new Date(2026, 10, 11, 15, 0, 0);
const plus = (ms: number) => new Date(now.getTime() + ms);
const MIN = 60_000;
const HOUR = 60 * MIN;

test("fmtUntil: a time that is not in the future is 'now'", () => {
  assert.equal(fmtUntil(now, now), "now");
  assert.equal(fmtUntil(plus(-HOUR), now), "now");
});

test("fmtUntil: minutes and hours inside one day", () => {
  assert.equal(fmtUntil(plus(30_000), now), "in under 1m");
  assert.equal(fmtUntil(plus(MIN), now), "in 1m");
  assert.equal(fmtUntil(plus(59 * MIN), now), "in 59m");
  assert.equal(fmtUntil(plus(HOUR), now), "in 1h");
  assert.equal(fmtUntil(plus(23 * HOUR + 59 * MIN), now), "in 23h");
});

test("fmtUntil: a weekday and the time inside six days, then the date", () => {
  assert.equal(fmtUntil(new Date(2026, 10, 12, 18, 0), now), "thu 18:00");
  assert.equal(fmtUntil(new Date(2026, 10, 16, 9, 5), now), "mon 09:05");
  assert.equal(fmtUntil(new Date(2026, 10, 21, 9, 0), now), "Nov 21 09:00");
  assert.equal(fmtUntil(new Date(2027, 0, 4, 14, 30), now), "Jan 4 14:30");
});

// 129-1: the peek schedule's bounds, with a pinned random source.
// 129-7: the daily cap, the gap between visits, and a moved clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECK_MS,
  FIRST_PAUSE_MS,
  GAP_MS,
  MAX_VISITS_PER_DAY,
  SHOW_MS,
  claimVisit,
  firstPeek,
  nextPeek,
  type VisitLog,
} from "./peek";

const fixed = (r: number) => () => r;
const EMPTY: VisitLog = { day: "", count: 0, nextAt: 0 };
const NOON = new Date(2026, 9, 28, 12).getTime();
const HOUR = 3_600_000;

test("the schedule opens hidden, for the short first pause", () => {
  assert.deepEqual(firstPeek(fixed(0)), { visible: false, ms: FIRST_PAUSE_MS[0] });
  assert.deepEqual(firstPeek(fixed(1)), { visible: false, ms: FIRST_PAUSE_MS[1] });
});

test("a granted visit shows and anything else stays hidden until the next check", () => {
  assert.equal(nextPeek(true, fixed(0.5)).visible, true);
  assert.deepEqual(nextPeek(false, fixed(0.5)), { visible: false, ms: CHECK_MS });
});

test("durations stay inside the bounds for every random value", () => {
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    const shown = nextPeek(true, fixed(r));
    assert.ok(shown.ms >= SHOW_MS[0] && shown.ms <= SHOW_MS[1], `show ${shown.ms} at ${r}`);
    const log = claimVisit(EMPTY, NOON, fixed(r));
    assert.ok(log);
    const gap = log.nextAt - NOON;
    assert.ok(gap >= GAP_MS[0] && gap <= GAP_MS[1], `gap ${gap} at ${r}`);
  }
  assert.equal(nextPeek(true, fixed(0)).ms, SHOW_MS[0]);
  assert.equal(claimVisit(EMPTY, NOON, fixed(1))?.nextAt, NOON + GAP_MS[1]);
});

test("a random source that misbehaves cannot make a step last forever or not at all", () => {
  for (const bad of [-1, 2, NaN, Infinity]) {
    const p = nextPeek(true, fixed(bad));
    assert.ok(p.ms >= SHOW_MS[0] && p.ms <= SHOW_MS[1], `show ${p.ms} at ${bad}`);
    const gap = claimVisit(EMPTY, NOON, fixed(bad))!.nextAt - NOON;
    assert.ok(gap >= GAP_MS[0] && gap <= GAP_MS[1], `gap ${gap} at ${bad}`);
  }
});

test("a pause is always longer than a showing", () => {
  assert.ok(GAP_MS[0] > SHOW_MS[1]);
  assert.ok(CHECK_MS > SHOW_MS[1]);
});

test("the first visit of a day is due at once and the next waits out the gap", () => {
  const first = claimVisit(EMPTY, NOON, fixed(0));
  assert.deepEqual(first, { day: "2026-10-28", count: 1, nextAt: NOON + GAP_MS[0] });
  assert.equal(claimVisit(first!, NOON + GAP_MS[0] - 1, fixed(0)), null);
  assert.equal(claimVisit(first!, NOON + GAP_MS[0], fixed(0))?.count, 2);
});

test("a full day stops at the cap for every random value", () => {
  for (const r of [0, 0.5, 1]) {
    let log = EMPTY;
    let visits = 0;
    const midnight = new Date(2026, 9, 28).getTime();
    for (let now = midnight; now < midnight + 24 * HOUR; now += CHECK_MS) {
      const claimed = claimVisit(log, now, fixed(r));
      if (claimed) {
        log = claimed;
        visits++;
      }
    }
    assert.equal(visits, MAX_VISITS_PER_DAY, `visits at ${r}`);
  }
});

test("the count starts again on a new day", () => {
  const spent: VisitLog = { day: "2026-10-28", count: MAX_VISITS_PER_DAY, nextAt: NOON + HOUR };
  assert.equal(claimVisit(spent, NOON + 2 * HOUR, fixed(0)), null);
  assert.equal(claimVisit(spent, NOON + 24 * HOUR, fixed(0))?.count, 1);
});

test("a next visit further away than any gap is a moved clock, not a wait", () => {
  const log: VisitLog = { day: "2026-10-28", count: 1, nextAt: NOON + GAP_MS[1] + 1 };
  assert.equal(claimVisit(log, NOON, fixed(0))?.count, 2);
});

// 129-1: the peek schedule's bounds, with a pinned random source.
// 129-7: the daily cap, the gap between visits, and a moved clock.
// 129-9: the daytime cap and the shorter gap in the evening.
// 129-16: the windows of the neutral scene, one visit in each.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECK_MS,
  EVENING_GAP_MS,
  EVENING_HOUR,
  FIRST_PAUSE_MS,
  GAP_MS,
  MAX_DAYTIME_VISITS,
  MAX_VISITS_PER_DAY,
  NEUTRAL_WINDOWS,
  SHOW_MS,
  claimNeutral,
  claimVisit,
  firstPeek,
  nextPeek,
  type NeutralLog,
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
  assert.ok(EVENING_GAP_MS[0] > SHOW_MS[1]);
  assert.ok(GAP_MS[0] > EVENING_GAP_MS[0]);
});

test("the first visit of a day is due at once and the next waits out the gap", () => {
  const first = claimVisit(EMPTY, NOON, fixed(0));
  assert.deepEqual(first, { day: "2026-10-28", count: 1, nextAt: NOON + GAP_MS[0] });
  assert.equal(claimVisit(first!, NOON + GAP_MS[0] - 1, fixed(0)), null);
  assert.equal(claimVisit(first!, NOON + GAP_MS[0], fixed(0))?.count, 2);
});

test("a full day stops at the cap and keeps visits back for the evening", () => {
  for (const r of [0, 0.5, 1]) {
    let log = EMPTY;
    let visits = 0;
    let daytime = 0;
    const midnight = new Date(2026, 9, 28).getTime();
    for (let now = midnight; now < midnight + 24 * HOUR; now += CHECK_MS) {
      const claimed = claimVisit(log, now, fixed(r));
      if (claimed) {
        log = claimed;
        visits++;
        if (now < midnight + EVENING_HOUR * HOUR) daytime++;
      }
    }
    assert.equal(visits, MAX_VISITS_PER_DAY, `visits at ${r}`);
    assert.ok(daytime <= MAX_DAYTIME_VISITS, `daytime visits ${daytime} at ${r}`);
  }
});

test("the evening spaces visits closer than the day", () => {
  const evening = new Date(2026, 9, 28, EVENING_HOUR).getTime();
  assert.equal(claimVisit(EMPTY, NOON, fixed(1))?.nextAt, NOON + GAP_MS[1]);
  assert.equal(claimVisit(EMPTY, evening, fixed(1))?.nextAt, evening + EVENING_GAP_MS[1]);
  assert.equal(claimVisit(EMPTY, evening - 1, fixed(1))?.nextAt, evening - 1 + GAP_MS[1]);
});

test("a day that used its daytime visits still has the evening's", () => {
  const log: VisitLog = { day: "2026-10-28", count: MAX_DAYTIME_VISITS, nextAt: 0 };
  assert.equal(claimVisit(log, NOON, fixed(0)), null);
  const evening = new Date(2026, 9, 28, EVENING_HOUR).getTime();
  assert.equal(claimVisit(log, evening, fixed(0))?.count, MAX_DAYTIME_VISITS + 1);
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

// 129-16: the neutral windows.
const NO_LOG: NeutralLog = { day: "", at: [], done: [] };

// Walks one local day in CHECK_MS steps and returns the times of the visits.
function walkDay(r: number, skip: (now: number) => boolean = () => false): number[] {
  const midnight = new Date(2026, 10, 10).getTime();
  let log = NO_LOG;
  const shown: number[] = [];
  for (let now = midnight; now < midnight + 24 * HOUR; now += CHECK_MS) {
    if (skip(now)) continue;
    const c = claimNeutral(log, now, fixed(r));
    log = c.log;
    if (c.show) shown.push(now);
  }
  return shown;
}

test("129-16: the neutral scene shows one time in each window and never outside", () => {
  for (const r of [0, 0.3, 0.7, 1]) {
    const shown = walkDay(r);
    assert.equal(shown.length, NEUTRAL_WINDOWS.length, String(r));
    shown.forEach((t, i) => {
      const h = new Date(t).getHours();
      const [a, b] = NEUTRAL_WINDOWS[i];
      assert.ok(h >= a && h < b, `visit at ${h}:00 for r ${r}`);
      assert.ok(t + SHOW_MS[1] <= new Date(2026, 10, 10, b).getTime() + CHECK_MS);
    });
  }
  assert.deepEqual(NEUTRAL_WINDOWS, [
    [8, 12],
    [16, 24],
  ]);
});

test("129-16: a target that no visible tab saw shows at the next check in its window", () => {
  const target = new Date(2026, 10, 10, 10).getTime();
  const shown = walkDay(0.5, (now) => now >= target - HOUR && now < target + HOUR);
  assert.equal(shown.length, 2);
  assert.equal(shown[0], target + HOUR);
});

test("129-16: a window that no visible tab saw is lost", () => {
  const shown = walkDay(0.5, (now) => new Date(now).getHours() < 12);
  assert.equal(shown.length, 1);
  assert.ok(new Date(shown[0]).getHours() >= 16);
});

test("129-16: the log keeps its targets, and a new day or a clock moved back gives a new log", () => {
  const nine = new Date(2026, 10, 10, 9).getTime();
  const first = claimNeutral(NO_LOG, nine, fixed(1));
  assert.equal(first.show, false);
  const again = claimNeutral(first.log, nine + CHECK_MS, fixed(0));
  assert.equal(again.log, first.log);
  assert.equal(again.show, false);
  const done: NeutralLog = { ...first.log, done: [true, true] };
  const next = claimNeutral(done, nine + 24 * HOUR, fixed(0));
  assert.equal(next.show, true);
  assert.deepEqual(next.log.done, [true, false]);
  const back = claimNeutral(done, nine - 24 * HOUR, fixed(0));
  assert.equal(back.show, true);
  assert.equal(back.log.day, "2026-11-9");
});

// 129-1: the season windows, against a fixed clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import { seasonFor, SEASONS, type Season } from "./seasons";

// Local-time constructor: the registry reads the reader's calendar.
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);

test("halloween runs from 24 october to 1 november, inclusive", () => {
  assert.equal(seasonFor(at(2026, 10, 23)), null);
  assert.equal(seasonFor(at(2026, 10, 24))?.id, "halloween");
  assert.equal(seasonFor(at(2026, 10, 31))?.id, "halloween");
  assert.equal(seasonFor(at(2026, 11, 1))?.id, "halloween");
  assert.equal(seasonFor(at(2026, 11, 2)), null);
});

test("the window is year-agnostic and accepts a millisecond timestamp", () => {
  assert.equal(seasonFor(at(2031, 10, 31).getTime())?.id, "halloween");
  assert.equal(seasonFor(at(1999, 10, 31))?.id, "halloween");
});

test("a window that wraps the year boundary holds both sides of it", () => {
  const wrap: Season[] = [{ id: "christmas", from: [12, 20], to: [1, 6] }];
  assert.equal(seasonFor(at(2026, 12, 19), wrap), null);
  assert.equal(seasonFor(at(2026, 12, 25), wrap)?.id, "christmas");
  assert.equal(seasonFor(at(2027, 1, 1), wrap)?.id, "christmas");
  assert.equal(seasonFor(at(2027, 1, 6), wrap)?.id, "christmas");
  assert.equal(seasonFor(at(2027, 1, 7), wrap), null);
  assert.equal(seasonFor(at(2027, 6, 1), wrap), null);
});

test("the registry has one window per season and no overlap", () => {
  const ids = new Set(SEASONS.map((s) => s.id));
  assert.equal(ids.size, SEASONS.length);
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= 28; d++) {
      const hits = SEASONS.filter((s) => seasonFor(at(2026, m, d), [s]) !== null);
      assert.ok(hits.length <= 1, `${m}/${d} falls in ${hits.length} seasons`);
    }
  }
});

// 129-1: the season windows, tested with a fixed clock.
// 129-8: the rows cover every day of the year, and two seasons have two rows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { inHours, inWindow, nightFor, seasonFor, SEASONS, type Season } from "./seasons";

// Local-time constructor, because the registry reads the calendar of the
// reader.
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);
const spooky = SEASONS.find((s) => s.id === "spooky-season")!;
const winterfest = SEASONS.find((s) => s.id === "winterfest")!;

test("every day of a leap year and of a common year falls in exactly one row", () => {
  for (const year of [2028, 2027]) {
    for (const day = at(year, 1, 1); day.getFullYear() === year; day.setDate(day.getDate() + 1)) {
      const hits = SEASONS.filter((s) => inWindow(day, s));
      assert.equal(hits.length, 1, `${day.toDateString()} falls in ${hits.length} rows`);
    }
  }
  assert.equal(seasonFor(at(2028, 2, 29))?.id, "winterfest");
});

test("the rows run in calendar order and hold the eight seasons", () => {
  const starts = SEASONS.map((s) => s.from[0] * 100 + s.from[1]);
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.equal(SEASONS.length, 10);
  assert.deepEqual([...new Set(SEASONS.map((s) => s.id))].sort(), [
    "green-season",
    "harvest-festival",
    "late-autumn",
    "midsummer",
    "new-year",
    "spooky-season",
    "spring-bloom",
    "winterfest",
  ]);
});

test("each season starts and ends on its calendar dates", () => {
  assert.equal(seasonFor(at(2026, 10, 14))?.id, "harvest-festival");
  assert.equal(seasonFor(at(2026, 10, 15))?.id, "spooky-season");
  assert.equal(seasonFor(at(2026, 11, 5))?.id, "spooky-season");
  assert.equal(seasonFor(at(2026, 11, 6))?.id, "late-autumn");
  assert.equal(seasonFor(at(2026, 12, 1))?.id, "winterfest");
  assert.equal(seasonFor(at(2026, 12, 30))?.id, "winterfest");
  assert.equal(seasonFor(at(2026, 12, 31))?.id, "new-year");
  assert.equal(seasonFor(at(2027, 1, 7))?.id, "new-year");
  assert.equal(seasonFor(at(2027, 1, 8))?.id, "winterfest");
  assert.equal(seasonFor(at(2027, 2, 28))?.id, "winterfest");
  assert.equal(seasonFor(at(2027, 3, 1))?.id, "spring-bloom");
  assert.equal(seasonFor(at(2027, 6, 21))?.id, "midsummer");
});

test("the window is year-agnostic and accepts a millisecond timestamp", () => {
  assert.equal(seasonFor(at(2031, 10, 31).getTime())?.id, "spooky-season");
  assert.equal(seasonFor(at(1999, 10, 31))?.id, "spooky-season");
});

test("a date outside every row gives no season", () => {
  assert.equal(seasonFor(at(2026, 6, 1), []), null);
});

test("a wrapped window holds both sides of the boundary", () => {
  const w: Season = { id: "winterfest", label: "x", from: [12, 20], to: [1, 6] };
  assert.equal(inWindow(at(2026, 12, 19), w), false);
  assert.equal(inWindow(at(2026, 12, 25), w), true);
  assert.equal(inWindow(at(2027, 1, 6), w), true);
  assert.equal(inWindow(at(2027, 1, 7), w), false);
});

// 129-6: the night frame on video tiles.
const atH = (y: number, m: number, d: number, h: number, min = 0) => new Date(y, m - 1, d, h, min, 0);

test("halloween night runs from 18:00 on 31 october until 03:00 on 1 november", () => {
  assert.equal(nightFor(spooky, atH(2026, 10, 31, 17, 59)), false);
  assert.equal(nightFor(spooky, atH(2026, 10, 31, 18, 0)), true);
  assert.equal(nightFor(spooky, atH(2026, 10, 31, 23, 59)), true);
  assert.equal(nightFor(spooky, atH(2026, 11, 1, 0, 0)), true);
  assert.equal(nightFor(spooky, atH(2026, 11, 1, 2, 59)), true);
  assert.equal(nightFor(spooky, atH(2026, 11, 1, 3, 0)), false);
  assert.equal(nightFor(spooky, atH(2026, 10, 30, 20, 0)), false);
});

test("winterfest has no night frame, and a wrapped hour window holds both sides of the year", () => {
  assert.equal(nightFor(winterfest, atH(2026, 12, 24, 20, 0)), false);
  const w = { from: [12, 31, 22] as [number, number, number], to: [1, 1, 2] as [number, number, number] };
  assert.equal(inHours(atH(2026, 12, 31, 21, 59), w), false);
  assert.equal(inHours(atH(2026, 12, 31, 22, 0), w), true);
  assert.equal(inHours(atH(2027, 1, 1, 1, 59), w), true);
  assert.equal(inHours(atH(2027, 1, 1, 2, 0), w), false);
});

test("a night window lies inside its season", () => {
  for (const s of SEASONS) {
    if (!s.night) continue;
    assert.ok(inWindow(at(2026, s.night.from[0], s.night.from[1]), s), `${s.id}: night starts outside the season`);
    assert.ok(inWindow(at(2026, s.night.to[0], s.night.to[1]), s), `${s.id}: night ends outside the season`);
  }
});

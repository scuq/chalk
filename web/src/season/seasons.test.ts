// 129-1: the season windows, tested with a fixed clock.
// 129-8: two seasons have two rows. 129-10: the rows leave gaps of 21 days, and
// ALWAYS_ON lists the hours in which the scene stays up.

import { test } from "node:test";
import assert from "node:assert/strict";
import { ALWAYS_ON, alwaysOn, inHours, inWindow, nightFor, seasonFor, SEASONS, type Season } from "./seasons";

// Local-time constructor, because the registry reads the calendar of the
// reader.
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);
const spooky = SEASONS.find((s) => s.id === "spooky-season")!;
const winterfest = SEASONS.find((s) => s.id === "winterfest")!;

test("no day of a leap year or of a common year falls in two rows", () => {
  for (const year of [2028, 2027]) {
    for (const day = at(year, 1, 1); day.getFullYear() === year; day.setDate(day.getDate() + 1)) {
      const hits = SEASONS.filter((s) => inWindow(day, s));
      assert.ok(hits.length <= 1, `${day.toDateString()} falls in ${hits.length} rows`);
    }
  }
});

test("the neutral gaps last 21 days, and 29 february falls in one", () => {
  const gaps: [number, number, number, number][] = [
    [1, 8, 1, 28],
    [2, 8, 2, 28],
    [4, 10, 4, 30],
    [5, 31, 6, 20],
    [8, 11, 8, 31],
    [9, 24, 10, 14],
    [11, 6, 11, 26],
    [12, 1, 12, 21],
  ];
  for (const [m1, d1, m2, d2] of gaps) {
    const first = at(2027, m1, d1);
    const last = at(2027, m2, d2);
    assert.equal(Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1, 21, `${m1}/${d1}`);
    for (const day = new Date(first); day <= last; day.setDate(day.getDate() + 1)) {
      assert.equal(seasonFor(day), null, day.toDateString());
    }
    assert.notEqual(seasonFor(new Date(first.getTime() - 86_400_000)), null, `before ${m1}/${d1}`);
    assert.notEqual(seasonFor(new Date(last.getTime() + 86_400_000)), null, `after ${m2}/${d2}`);
  }
  assert.equal(seasonFor(at(2028, 2, 29)), null);
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
  const rows: [string, number, number, number, number][] = [
    ["new-year", 1, 1, 1, 7],
    ["winterfest", 1, 29, 2, 7],
    ["spring-bloom", 3, 1, 4, 9],
    ["green-season", 5, 1, 5, 30],
    ["midsummer", 6, 21, 8, 10],
    ["harvest-festival", 9, 1, 9, 23],
    ["spooky-season", 10, 15, 11, 5],
    ["late-autumn", 11, 27, 11, 30],
    ["winterfest", 12, 22, 12, 30],
    ["new-year", 12, 31, 12, 31],
  ];
  for (const [id, m1, d1, m2, d2] of rows) {
    assert.equal(seasonFor(at(2027, m1, d1))?.id, id);
    assert.equal(seasonFor(at(2027, m2, d2))?.id, id);
  }
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

test("the always-on hours run from 20:00 to 05:00 on 24 december and new year's eve", () => {
  assert.equal(alwaysOn(atH(2026, 12, 24, 19, 59)), false);
  assert.equal(alwaysOn(atH(2026, 12, 24, 20, 0)), true);
  assert.equal(alwaysOn(atH(2026, 12, 25, 4, 59)), true);
  assert.equal(alwaysOn(atH(2026, 12, 25, 5, 0)), false);
  assert.equal(alwaysOn(atH(2026, 12, 31, 19, 59)), false);
  assert.equal(alwaysOn(atH(2026, 12, 31, 20, 0)), true);
  assert.equal(alwaysOn(atH(2027, 1, 1, 0, 0)), true);
  assert.equal(alwaysOn(atH(2027, 1, 1, 4, 59)), true);
  assert.equal(alwaysOn(atH(2027, 1, 1, 5, 0)), false);
  assert.equal(alwaysOn(atH(2026, 12, 25, 20, 0)), false);
  assert.equal(alwaysOn(atH(2026, 7, 1, 22, 0)), false);
});

test("every always-on hour falls inside a season", () => {
  for (const w of ALWAYS_ON) {
    const [m1, d1] = w.from;
    const [m2, d2] = w.to;
    assert.ok(seasonFor(at(2026, m1, d1)), `${m1}/${d1} has no season`);
    assert.ok(seasonFor(at(2027, m2, d2)), `${m2}/${d2} has no season`);
  }
});

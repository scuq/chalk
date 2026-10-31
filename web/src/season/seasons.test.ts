// 129-1: the season windows, tested with a fixed clock. 129-4 adds winter and
// the aura window. 129-5 adds the figure pick.

import { test } from "node:test";
import assert from "node:assert/strict";
import { auraFor, inWindow, pickFigure, seasonFor, SEASONS, type Season } from "./seasons";

// Local-time constructor, because the registry reads the calendar of the
// reader.
const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0, 0);
const halloween = SEASONS.find((s) => s.id === "halloween")!;
const winter = SEASONS.find((s) => s.id === "winter")!;

test("halloween runs from 24 october to 1 november, inclusive", () => {
  assert.equal(seasonFor(at(2026, 10, 23)), null);
  assert.equal(seasonFor(at(2026, 10, 24))?.id, "halloween");
  assert.equal(seasonFor(at(2026, 10, 31))?.id, "halloween");
  assert.equal(seasonFor(at(2026, 11, 1))?.id, "halloween");
  assert.equal(seasonFor(at(2026, 11, 2)), null);
});

test("winter runs from 1 december to 6 january, across the year boundary", () => {
  assert.equal(seasonFor(at(2026, 11, 30)), null);
  assert.equal(seasonFor(at(2026, 12, 1))?.id, "winter");
  assert.equal(seasonFor(at(2026, 12, 25))?.id, "winter");
  assert.equal(seasonFor(at(2027, 1, 1))?.id, "winter");
  assert.equal(seasonFor(at(2027, 1, 6))?.id, "winter");
  assert.equal(seasonFor(at(2027, 1, 7)), null);
  assert.equal(seasonFor(at(2027, 6, 1)), null);
});

test("the window is year-agnostic and accepts a millisecond timestamp", () => {
  assert.equal(seasonFor(at(2031, 10, 31).getTime())?.id, "halloween");
  assert.equal(seasonFor(at(1999, 10, 31))?.id, "halloween");
});

test("a wrapped window holds both sides of the boundary", () => {
  const w: Season = { id: "winter", from: [12, 20], to: [1, 6], figures: ["x"] };
  assert.equal(inWindow(at(2026, 12, 19), w), false);
  assert.equal(inWindow(at(2026, 12, 25), w), true);
  assert.equal(inWindow(at(2027, 1, 6), w), true);
  assert.equal(inWindow(at(2027, 1, 7), w), false);
});

test("halloween's glow runs the whole season; winter's only on 23 to 25 december", () => {
  assert.equal(auraFor(halloween, at(2026, 10, 24)), true);
  assert.equal(auraFor(halloween, at(2026, 11, 1)), true);
  assert.equal(auraFor(winter, at(2026, 12, 22)), false);
  assert.equal(auraFor(winter, at(2026, 12, 23)), true);
  assert.equal(auraFor(winter, at(2026, 12, 24)), true);
  assert.equal(auraFor(winter, at(2026, 12, 25)), true);
  assert.equal(auraFor(winter, at(2026, 12, 26)), false);
  assert.equal(auraFor(winter, at(2027, 1, 1)), false);
});

test("the registry has one window per season, no overlap, and ten figures each", () => {
  const ids = new Set(SEASONS.map((s) => s.id));
  assert.equal(ids.size, SEASONS.length);
  for (let m = 1; m <= 12; m++) {
    for (let d = 1; d <= 28; d++) {
      const hits = SEASONS.filter((s) => inWindow(at(2026, m, d), s));
      assert.ok(hits.length <= 1, `${m}/${d} falls in ${hits.length} seasons`);
    }
  }
  for (const s of SEASONS) {
    assert.equal(s.figures.length, 10, `${s.id} has ${s.figures.length} figures`);
    assert.equal(new Set(s.figures).size, s.figures.length, `${s.id} repeats a figure`);
    if (s.aura) {
      // The aura window lies inside the season.
      assert.ok(inWindow(at(2026, s.aura.from[0], s.aura.from[1]), s), `${s.id}: aura starts outside the season`);
      assert.ok(inWindow(at(2026, s.aura.to[0], s.aura.to[1]), s), `${s.id}: aura ends outside the season`);
    }
  }
});

test("a visit picks any figure, never the one before, and a bad random source still picks", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 10; i++) seen.add(pickFigure(halloween, () => i / 10));
  assert.equal(seen.size, 10);
  for (let i = 0; i < 10; i++) {
    assert.notEqual(pickFigure(halloween, () => i / 10, "ghost"), "ghost");
  }
  for (const bad of [-1, 1, 2, NaN, Infinity]) {
    assert.ok(halloween.figures.includes(pickFigure(halloween, () => bad)));
  }
  const one: Season = { id: "halloween", from: [1, 1], to: [1, 1], figures: ["only"] };
  assert.equal(pickFigure(one, () => 0.5, "only"), "only");
});

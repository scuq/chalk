// 129-1: the peek schedule's bounds and alternation, with a pinned random source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { FIRST_PAUSE_MS, HIDE_MS, SHOW_MS, firstPeek, nextPeek } from "./peek";

const fixed = (r: number) => () => r;

test("the schedule opens hidden, for the short first pause", () => {
  assert.deepEqual(firstPeek(fixed(0)), { visible: false, ms: FIRST_PAUSE_MS[0] });
  assert.deepEqual(firstPeek(fixed(1)), { visible: false, ms: FIRST_PAUSE_MS[1] });
});

test("shown follows hidden and hidden follows shown", () => {
  assert.equal(nextPeek(false, fixed(0.5)).visible, true);
  assert.equal(nextPeek(true, fixed(0.5)).visible, false);
});

test("durations stay inside the bounds for every random value", () => {
  for (const r of [0, 0.25, 0.5, 0.75, 1]) {
    const shown = nextPeek(false, fixed(r));
    assert.ok(shown.ms >= SHOW_MS[0] && shown.ms <= SHOW_MS[1], `show ${shown.ms} at ${r}`);
    const hidden = nextPeek(true, fixed(r));
    assert.ok(hidden.ms >= HIDE_MS[0] && hidden.ms <= HIDE_MS[1], `hide ${hidden.ms} at ${r}`);
  }
  assert.equal(nextPeek(false, fixed(0)).ms, SHOW_MS[0]);
  assert.equal(nextPeek(true, fixed(1)).ms, HIDE_MS[1]);
});

test("a random source that misbehaves cannot make a step last forever or not at all", () => {
  for (const bad of [-1, 2, NaN, Infinity]) {
    const p = nextPeek(true, fixed(bad));
    assert.ok(p.ms >= HIDE_MS[0] && p.ms <= HIDE_MS[1], `hide ${p.ms} at ${bad}`);
  }
});

test("a pause is always longer than a showing", () => {
  assert.ok(HIDE_MS[0] > SHOW_MS[1]);
});

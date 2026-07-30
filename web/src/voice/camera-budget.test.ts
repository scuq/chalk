// 52-3: the frame-budget ladder.
//
// This is the part that decides whether someone's video stutters, and it is
// impossible to eyeball in a browser -- by the time you can see the difference
// you cannot tell which rung you are on. So it is pure, and pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GIVE_UP_FRAMES,
  INITIAL_CADENCE,
  MAX_EVERY,
  RECOVER_FRAMES,
  ema,
  planCadence,
  shouldRunExpensiveStep,
} from "./camera-budget.ts";

const BUDGET = 33; // ~30fps

/** Feed the same cost n times, as a run of frames would. */
function run(cost: number, n: number, from = INITIAL_CADENCE) {
  let c = { ...from, giveUp: false };
  for (let i = 0; i < n; i++) c = planCadence(c, cost, BUDGET);
  return c;
}

test("a comfortable machine segments every frame", () => {
  const c = run(5, 100);
  assert.equal(c.every, 1);
  assert.equal(c.giveUp, false);
});

test("one slow frame backs off immediately", () => {
  // Fast down: the far end is already stuttering by the time we notice.
  const c = planCadence(INITIAL_CADENCE, 30, BUDGET);
  assert.equal(c.every, 2);
});

test("backing off stops at the floor rather than lagging forever", () => {
  const c = run(30, 200);
  assert.equal(c.every, MAX_EVERY);
});

test("recovery needs a sustained comfortable run, not one good frame", () => {
  const backedOff = { every: 2, good: 0, bad: 0 };
  assert.equal(planCadence(backedOff, 2, BUDGET).every, 2);
  assert.equal(run(2, RECOVER_FRAMES - 1, backedOff).every, 2);
  assert.equal(run(2, RECOVER_FRAMES, backedOff).every, 1);
});

test("stepping down resets the streak so one rung is judged at a time", () => {
  // The bug this guards: carrying the previous rung's misses forward walks
  // straight to the floor on the first slow frame.
  const c = planCadence(INITIAL_CADENCE, 30, BUDGET);
  assert.equal(c.bad, 0);
  assert.equal(c.good, 0);
});

test("sitting in the middle band holds the cadence and banks no credit", () => {
  // Right on the line: fitting, but not comfortably. Stepping up from here is
  // how a cadence starts oscillating.
  const middle = BUDGET * 0.6;
  const c = run(middle, 100, { every: 2, good: 0, bad: 0 });
  assert.equal(c.every, 2);
  assert.equal(c.good, 0);
});

test("give up only at the floor, and only after a sustained run", () => {
  let c = run(30, GIVE_UP_FRAMES, INITIAL_CADENCE);
  assert.equal(c.every, MAX_EVERY);
  assert.equal(c.giveUp, false, "still riding it out");
  c = run(30, GIVE_UP_FRAMES * 2, INITIAL_CADENCE);
  assert.equal(c.giveUp, true);
});

test("a transient slow patch never gives up", () => {
  // A tab switch or a GC pause: slow for a moment, then fine.
  let c = run(40, 10);
  c = run(2, 100, c);
  assert.equal(c.giveUp, false);
  assert.equal(c.every, 1, "and it recovers all the way");
});

test("a budget that makes no sense leaves the cadence alone", () => {
  for (const bad of [0, -1, NaN, Infinity]) {
    const c = planCadence({ every: 2, good: 3, bad: 4 }, 100, bad);
    assert.equal(c.every, 2);
    assert.equal(c.giveUp, false);
  }
});

test("the first frame always segments, whatever the cadence", () => {
  // Nothing to reuse yet: skipping it composites the person out of an empty
  // mask, i.e. publishes nothing but blur.
  for (const every of [1, 2, MAX_EVERY]) {
    assert.equal(shouldRunExpensiveStep(0, every), true);
  }
});

test("cadence 2 segments every other frame", () => {
  const ran = [0, 1, 2, 3, 4, 5].map((f) => shouldRunExpensiveStep(f, 2));
  assert.deepEqual(ran, [true, false, true, false, true, false]);
});

test("cadence 3 segments one frame in three", () => {
  const ran = [0, 1, 2, 3, 4, 5].map((f) => shouldRunExpensiveStep(f, 3));
  assert.deepEqual(ran, [true, false, false, true, false, false]);
});

test("the first sample seeds the average instead of decaying from zero", () => {
  // Starting at 0 would report a machine as fast for its first second.
  assert.equal(ema(null, 42), 42);
});

test("one outlier barely moves the average", () => {
  const steady = 10;
  assert.ok(ema(steady, 200) < 30, "a GC pause must not move the cadence alone");
});

test("a sustained change is followed", () => {
  let v = ema(null, 10);
  for (let i = 0; i < 100; i++) v = ema(v, 40);
  assert.ok(Math.abs(v - 40) < 1);
});

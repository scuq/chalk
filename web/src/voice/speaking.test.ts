// 63-2: the speaking tracker behind the green audio dot.

import test from "node:test";
import assert from "node:assert/strict";

import { SpeakingTracker, SPEAKING_LEVEL, SPEAKING_HOLD_MS } from "./speaking";

test("a loud fresh sample lights the key", () => {
  const tr = new SpeakingTracker();
  tr.sample("a:1", 0.3, true, 1000);
  assert.deepEqual(tr.current(1000), ["a:1"]);
});

test("noise-floor samples do not light", () => {
  const tr = new SpeakingTracker();
  tr.sample("a:1", SPEAKING_LEVEL / 2, true, 1000);
  assert.deepEqual(tr.current(1000), []);
});

test("a stale (DTX-frozen) sample does not light, whatever its level", () => {
  const tr = new SpeakingTracker();
  tr.sample("a:1", 0.9, false, 1000);
  assert.deepEqual(tr.current(1000), []);
});

test("the dot holds through a between-words pause, then expires", () => {
  const tr = new SpeakingTracker();
  tr.sample("a:1", 0.3, true, 1000);
  assert.deepEqual(tr.current(1000 + SPEAKING_HOLD_MS), ["a:1"]);
  assert.deepEqual(tr.current(1000 + SPEAKING_HOLD_MS + 1), []);
});

test("expiry forgets the key entirely (departed peers don't accumulate)", () => {
  const tr = new SpeakingTracker();
  tr.sample("gone:1", 0.3, true, 1000);
  assert.deepEqual(tr.current(10_000), []);
  // Re-lighting still works after the purge.
  tr.sample("gone:1", 0.3, true, 20_000);
  assert.deepEqual(tr.current(20_000), ["gone:1"]);
});

test("multiple speakers report sorted", () => {
  const tr = new SpeakingTracker();
  tr.sample("b:2", 0.3, true, 1000);
  tr.sample("a:1", 0.3, true, 1001);
  assert.deepEqual(tr.current(1001), ["a:1", "b:2"]);
});

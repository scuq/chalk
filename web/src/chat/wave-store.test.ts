// 115-3: the wave store -- a transient per-person timestamp with a clock.

import { test } from "node:test";
import assert from "node:assert/strict";

import { WAVE_MS } from "./wave";
import { waveStore } from "./wave-store";

const T0 = 1_000_000;

function reset() {
  waveStore.clearAll();
}

test("a triggered wave is active until WAVE_MS, then over", () => {
  reset();
  waveStore.trigger("alice", T0);
  assert.equal(waveStore.activeFor("alice", T0), T0);
  assert.equal(waveStore.activeFor("alice", T0 + WAVE_MS - 1), T0);
  assert.equal(waveStore.activeFor("alice", T0 + WAVE_MS), null);
  assert.equal(waveStore.activeFor("nobody", T0), null);
  reset();
});

// The component keys its markup on the start time, so a re-trigger must
// yield a new one or the second wave would never be drawn.
test("re-triggering restarts the wave with a new start time", () => {
  reset();
  waveStore.trigger("alice", T0);
  waveStore.trigger("alice", T0 + 1000);
  assert.equal(waveStore.activeFor("alice", T0 + 1000), T0 + 1000);
  assert.equal(waveStore.activeFor("alice", T0 + 1000 + WAVE_MS - 1), T0 + 1000);
  reset();
});

test("active lists every running wave and only those", () => {
  reset();
  waveStore.trigger("alice", T0);
  waveStore.trigger("bob", T0 + 500);
  assert.deepEqual(
    [...waveStore.active(T0 + WAVE_MS)],
    [["bob", T0 + 500]],
  );
  reset();
});

test("sweep forgets finished waves, notifies, and stops the clock when empty", () => {
  reset();
  let hits = 0;
  const off = waveStore.subscribe(() => {
    hits++;
  });
  waveStore.trigger("alice", T0);
  assert.equal(hits, 1);
  assert.equal(waveStore.isTicking(), true);
  waveStore.sweep(T0 + 100);
  assert.equal(hits, 1, "still running: no notification");
  waveStore.sweep(T0 + WAVE_MS);
  assert.equal(hits, 2);
  assert.equal(waveStore.isTicking(), false);
  off();
  reset();
});

test("clearAll drops everything and stops the clock", () => {
  reset();
  waveStore.trigger("alice", T0);
  waveStore.clearAll();
  assert.equal(waveStore.activeFor("alice", T0), null);
  assert.equal(waveStore.isTicking(), false);
});

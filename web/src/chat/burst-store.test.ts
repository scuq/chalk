// 115-1: the burst model. The threshold is the reader's, the clock is a
// parameter, and the verdict is sticky for the window after the last message.

import { test } from "node:test";
import assert from "node:assert/strict";

import { burstStore } from "./burst-store";

const T0 = 1_000_000;
const MIN = 60_000;

// One module singleton for the whole suite. clearAll also stops the sweep
// timer, which keeps the runner from hanging on a pending interval.
function reset(count = 4, windowMs = 4 * MIN) {
  burstStore.clearAll();
  burstStore.configure(count, windowMs, T0);
}

test("one short of the threshold is not hot; the threshold is", () => {
  reset();
  for (let i = 0; i < 3; i++) burstStore.note("chan", T0 + i * 1000);
  assert.equal(burstStore.hot("chan", T0 + 3000), false);
  assert.equal(burstStore.countIn("chan", T0 + 3000), 3);
  burstStore.note("chan", T0 + 3000);
  assert.equal(burstStore.hot("chan", T0 + 3000), true);
  assert.equal(burstStore.countIn("chan", T0 + 3000), 4);
  reset();
});

test("messages spread wider than the window never add up", () => {
  reset();
  // Four messages, but each a window-and-a-bit apart: never more than one
  // inside the window at once.
  for (let i = 0; i < 4; i++) burstStore.note("chan", T0 + i * (4 * MIN + 1));
  assert.equal(burstStore.hot("chan", T0 + 3 * (4 * MIN + 1)), false);
  reset();
});

test("a flame stays lit for the window after the last message, then goes out", () => {
  reset();
  for (let i = 0; i < 4; i++) burstStore.note("chan", T0 + i * 1000);
  const last = T0 + 3000;
  assert.equal(burstStore.hot("chan", last + 4 * MIN - 1), true);
  assert.equal(burstStore.hot("chan", last + 4 * MIN), false);
  reset();
});

// The sticky rule: the oldest message of the burst slides out of the window
// while new ones keep coming, and the flame must not blink.
test("a continuing burst keeps the flame lit without a gap", () => {
  reset();
  for (let i = 0; i < 4; i++) burstStore.note("chan", T0 + i * MIN);
  // At T0 + 4min the first message has left the window; a fifth arrives.
  burstStore.note("chan", T0 + 4 * MIN);
  assert.equal(burstStore.hot("chan", T0 + 4 * MIN), true);
  assert.equal(burstStore.hot("chan", T0 + 8 * MIN - 1), true);
  assert.equal(burstStore.hot("chan", T0 + 8 * MIN), false);
  reset();
});

test("channels are independent", () => {
  reset();
  for (let i = 0; i < 4; i++) burstStore.note("a", T0 + i);
  burstStore.note("b", T0);
  assert.equal(burstStore.hot("a", T0 + 3), true);
  assert.equal(burstStore.hot("b", T0 + 3), false);
  assert.equal(burstStore.hot("nope", T0 + 3), false);
  assert.deepEqual([...burstStore.hotChannels(T0 + 3)], ["a"]);
  reset();
});

test("sweep puts an expired flame out and forgets an idle channel", () => {
  reset();
  for (let i = 0; i < 4; i++) burstStore.note("chan", T0 + i);
  let hits = 0;
  const off = burstStore.subscribe(() => {
    hits++;
  });
  burstStore.sweep(T0 + MIN);
  assert.equal(hits, 0, "still lit: no notification");
  burstStore.sweep(T0 + 3 + 4 * MIN);
  assert.equal(hits, 1);
  assert.equal(burstStore.hot("chan", T0 + 3 + 4 * MIN), false);
  assert.equal(burstStore.isTicking(), false, "nothing left to expire");
  off();
  reset();
});

// Lowering the count in settings should light a flame from what is already
// remembered, and raising it should put one out, without waiting for the
// next message.
test("reconfiguring re-derives every verdict from the remembered arrivals", () => {
  reset(4, 4 * MIN);
  for (let i = 0; i < 3; i++) burstStore.note("chan", T0 + i);
  assert.equal(burstStore.hot("chan", T0 + 3), false);
  burstStore.configure(2, 4 * MIN, T0 + 3);
  assert.equal(burstStore.hot("chan", T0 + 3), true);
  burstStore.configure(10, 4 * MIN, T0 + 4);
  assert.equal(burstStore.hot("chan", T0 + 4), false);
  reset();
});

test("subscribers hear a flame light, not every message", () => {
  reset();
  let hits = 0;
  const off = burstStore.subscribe(() => {
    hits++;
  });
  for (let i = 0; i < 3; i++) burstStore.note("chan", T0 + i);
  assert.equal(hits, 0);
  burstStore.note("chan", T0 + 3);
  assert.equal(hits, 1);
  burstStore.note("chan", T0 + 4);
  assert.equal(hits, 1, "already lit: no notification");
  off();
  reset();
});

// The timer exists to put flames out. With nothing remembered it is waste,
// so it must not run at rest.
test("the sweep timer runs only while something is remembered", () => {
  reset();
  assert.equal(burstStore.isTicking(), false);
  burstStore.note("chan", T0);
  assert.equal(burstStore.isTicking(), true);
  burstStore.sweep(T0 + 4 * MIN + 1);
  assert.equal(burstStore.isTicking(), false);
  burstStore.note("chan", T0);
  burstStore.clearAll();
  assert.equal(burstStore.isTicking(), false);
  assert.equal(burstStore.hot("chan", T0), false);
});

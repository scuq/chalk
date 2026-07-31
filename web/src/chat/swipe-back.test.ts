// 64-3: the edge-swipe-back gesture rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beginSwipe,
  swipeTriggered,
  SWIPE_EDGE_PX,
  SWIPE_TRIGGER_PX,
} from "./swipe-back.ts";

test("only touches in the left-edge gutter arm the gesture", () => {
  assert.deepEqual(beginSwipe(0, 100), { x: 0, y: 100 });
  assert.deepEqual(beginSwipe(SWIPE_EDGE_PX, 50), { x: SWIPE_EDGE_PX, y: 50 });
  assert.equal(beginSwipe(SWIPE_EDGE_PX + 1, 50), null);
  assert.equal(beginSwipe(200, 50), null);
});

test("triggers once the finger travels far enough right", () => {
  const start = { x: 10, y: 100 };
  assert.equal(swipeTriggered(start, 10 + SWIPE_TRIGGER_PX - 1, 100), false);
  assert.equal(swipeTriggered(start, 10 + SWIPE_TRIGGER_PX, 100), true);
});

test("a mostly-vertical drag never triggers", () => {
  const start = { x: 10, y: 100 };
  // Far enough right, but the vertical drift dominates: a scroll, not a
  // back swipe.
  assert.equal(swipeTriggered(start, 10 + SWIPE_TRIGGER_PX, 100 + SWIPE_TRIGGER_PX), false);
  // Horizontal dominance boundary: dy exactly half of dx still counts.
  assert.equal(swipeTriggered(start, 10 + SWIPE_TRIGGER_PX, 100 + SWIPE_TRIGGER_PX / 2), true);
});

test("leftward movement never triggers", () => {
  const start = { x: 30, y: 100 };
  assert.equal(swipeTriggered(start, 30 - SWIPE_TRIGGER_PX, 100), false);
});

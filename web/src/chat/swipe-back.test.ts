// 64-3/64-4: the swipe-back gesture rules.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  swipeCancelled,
  swipeTriggered,
  SWIPE_CANCEL_PX,
  SWIPE_TRIGGER_PX,
} from "./swipe-back.ts";

test("triggers once the finger travels far enough right", () => {
  const start = { x: 200, y: 100 };
  assert.equal(swipeTriggered(start, 200 + SWIPE_TRIGGER_PX - 1, 100), false);
  assert.equal(swipeTriggered(start, 200 + SWIPE_TRIGGER_PX, 100), true);
});

test("a mostly-vertical drag never triggers", () => {
  const start = { x: 200, y: 100 };
  // Far enough right, but the vertical drift dominates: a scroll, not a
  // back swipe.
  assert.equal(swipeTriggered(start, 200 + SWIPE_TRIGGER_PX, 100 + SWIPE_TRIGGER_PX), false);
  // Horizontal dominance boundary: dy exactly half of dx still counts.
  assert.equal(swipeTriggered(start, 200 + SWIPE_TRIGGER_PX, 100 + SWIPE_TRIGGER_PX / 2), true);
});

test("leftward movement never triggers", () => {
  const start = { x: 200, y: 100 };
  assert.equal(swipeTriggered(start, 200 - SWIPE_TRIGGER_PX, 100), false);
});

test("cancels once vertical motion dominates", () => {
  const start = { x: 200, y: 100 };
  // Clearly a scroll: down more than sideways, past the cancel slop.
  assert.equal(swipeCancelled(start, 210, 100 + SWIPE_CANCEL_PX), true);
  assert.equal(swipeCancelled(start, 210, 100 - SWIPE_CANCEL_PX), true);
  // Small vertical drift is not a scroll yet.
  assert.equal(swipeCancelled(start, 210, 100 + SWIPE_CANCEL_PX - 1), false);
  // Rightward-dominant motion is never a cancel, however far it goes.
  assert.equal(swipeCancelled(start, 200 + 100, 100 + SWIPE_CANCEL_PX + 8), false);
});

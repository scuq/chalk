// 64-3/64-4: the swipe-back gesture rules. 64-6: the trigger distance
// scales down near the right screen edge, where a fixed threshold was
// physically unreachable.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  swipeCancelled,
  swipeTriggered,
  SWIPE_CANCEL_PX,
  SWIPE_TRIGGER_MIN_PX,
  SWIPE_TRIGGER_PX,
} from "./swipe-back.ts";

// Wide enough that the runway never shortens the trigger: the full
// SWIPE_TRIGGER_PX applies from x=200 on a 390pt screen.
const WIDTH = 390;

test("triggers once the finger travels far enough right", () => {
  const start = { x: 200, y: 100 };
  assert.equal(swipeTriggered(start, 200 + SWIPE_TRIGGER_PX - 1, 100, WIDTH), false);
  assert.equal(swipeTriggered(start, 200 + SWIPE_TRIGGER_PX, 100, WIDTH), true);
});

test("a mostly-vertical drag never triggers", () => {
  const start = { x: 200, y: 100 };
  // Far enough right, but the vertical drift dominates: a scroll, not a
  // back swipe.
  assert.equal(swipeTriggered(start, 200 + SWIPE_TRIGGER_PX, 100 + SWIPE_TRIGGER_PX, WIDTH), false);
  // Horizontal dominance boundary: dy exactly half of dx still counts.
  assert.equal(swipeTriggered(start, 200 + SWIPE_TRIGGER_PX, 100 + SWIPE_TRIGGER_PX / 2, WIDTH), true);
});

test("leftward movement never triggers", () => {
  const start = { x: 200, y: 100 };
  assert.equal(swipeTriggered(start, 200 - SWIPE_TRIGGER_PX, 100, WIDTH), false);
});

test("near the right edge the trigger shrinks to the available runway", () => {
  // 50px of runway: the fixed 64px threshold could never be met, the
  // scaled one (60% of 50 = 30px) can.
  const start = { x: WIDTH - 50, y: 100 };
  assert.equal(swipeTriggered(start, start.x + 30, 100, WIDTH), true);
  assert.equal(swipeTriggered(start, start.x + 29, 100, WIDTH), false);
});

test("the shrunken trigger never drops below the floor", () => {
  // 10px of runway: 60% would be 6px, but a tap that wobbles 6px right
  // must not navigate. The floor keeps this zone quasi-dead on purpose.
  const start = { x: WIDTH - 10, y: 100 };
  assert.equal(swipeTriggered(start, start.x + SWIPE_TRIGGER_MIN_PX - 1, 100, WIDTH), false);
  assert.equal(swipeTriggered(start, start.x + SWIPE_TRIGGER_MIN_PX, 100, WIDTH), true);
});

test("vertical dominance still cancels near the edge", () => {
  const start = { x: WIDTH - 50, y: 100 };
  assert.equal(swipeTriggered(start, start.x + 30, 100 + 30, WIDTH), false);
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

// 64-3/64-4: the swipe-back gesture rules. 64-6: the trigger distance
// scales down near the right screen edge, where a fixed threshold was
// physically unreachable. 64-12: arming, tracking and the release decision,
// now that the surface follows the finger instead of jumping at 64px.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  swipeArmed,
  swipeCancelled,
  swipeCommits,
  swipeOffset,
  swipeTriggered,
  SWIPE_ARM_PX,
  SWIPE_CANCEL_PX,
  SWIPE_FLICK_PX_PER_MS,
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

// -- 64-12: arming, tracking, releasing --------------------------------

test("arms well before the trigger, but not on a tap's worth of drift", () => {
  const start = { x: 200, y: 100 };
  assert.equal(swipeArmed(start, 200 + SWIPE_ARM_PX - 1, 100), false);
  assert.equal(swipeArmed(start, 200 + SWIPE_ARM_PX, 100), true);
  // Arming is much cheaper than triggering: that is the whole point, the
  // surface has to move before anyone can judge how far to push it.
  assert.ok(SWIPE_ARM_PX < SWIPE_TRIGGER_PX);
});

test("arming wants the same horizontal dominance the trigger does", () => {
  const start = { x: 200, y: 100 };
  // A drag going down as fast as it goes right is a scroll starting off
  // crooked, not a back swipe.
  assert.equal(swipeArmed(start, 200 + 40, 100 + 40), false);
  assert.equal(swipeArmed(start, 200 + 40, 100 + 20), true);
});

test("the surface tracks the finger, and never leftward", () => {
  const start = { x: 200, y: 100 };
  assert.equal(swipeOffset(start, 260), 60);
  assert.equal(swipeOffset(start, 200), 0);
  // Dragging back past where it began does not push the screen off the
  // other side; the gesture only goes back.
  assert.equal(swipeOffset(start, 120), 0);
});

test("a slow drag commits on distance alone", () => {
  const start = { x: 200, y: 100 };
  const slow = 4000; // ms: far too slow to count as a flick
  assert.equal(swipeCommits(start, 200 + SWIPE_TRIGGER_PX, 100, WIDTH, slow), true);
  assert.equal(swipeCommits(start, 200 + SWIPE_TRIGGER_PX - 1, 100, WIDTH, slow), false);
});

test("a flick commits short of the trigger distance", () => {
  const start = { x: 200, y: 100 };
  const dx = SWIPE_TRIGGER_MIN_PX + 4;
  const fast = dx / SWIPE_FLICK_PX_PER_MS; // exactly at the flick speed
  assert.ok(dx < SWIPE_TRIGGER_PX, "the flick must be shorter than the trigger");
  assert.equal(swipeCommits(start, 200 + dx, 100, WIDTH, fast), true);
  // Same distance taken at half the speed is a drag that stopped early.
  assert.equal(swipeCommits(start, 200 + dx, 100, WIDTH, fast * 2), false);
});

test("a fast flick still needs real travel, so a quick tap cannot navigate", () => {
  const start = { x: 200, y: 100 };
  // Faster than any flick, but it covered less than the minimum: this is
  // the finger jitter of a tap, and it must stay a tap.
  const dx = SWIPE_TRIGGER_MIN_PX - 1;
  assert.equal(swipeCommits(start, 200 + dx, 100, WIDTH, 1), false);
});

test("a flick that is really a fast scroll does not commit", () => {
  const start = { x: 200, y: 100 };
  const dx = SWIPE_TRIGGER_MIN_PX + 4;
  // Moving down further than it moved right, quickly: a flung scroll.
  assert.equal(swipeCommits(start, 200 + dx, 100 + dx * 2, WIDTH, 20), false);
});

test("the release rule inherits the shortened trigger near the right edge", () => {
  // 50px of runway, so the distance rule trips at 30px (60% of it) -- a
  // release there commits without needing flick speed.
  const start = { x: WIDTH - 50, y: 100 };
  assert.equal(swipeCommits(start, start.x + 30, 100, WIDTH, 4000), true);
});

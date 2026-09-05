// chalk 110-1 -- gallery/swipe rules.

import test from "node:test";
import assert from "node:assert/strict";
import {
  GALLERY_ARM_PX,
  GALLERY_CANCEL_PX,
  GALLERY_COMMIT_PX,
  GALLERY_FLICK_MIN_PX,
  stepIndex,
  swipeActionFor,
  swipeArmedX,
  swipeCancelledX,
  swipeCommitDir,
  swipeOffsetX,
} from "./gallery.ts";

test("stepIndex clamps at both ends rather than wrapping", () => {
  assert.equal(stepIndex(0, 4, 1), 1);
  assert.equal(stepIndex(3, 4, 1), 3);
  assert.equal(stepIndex(0, 4, -1), 0);
  assert.equal(stepIndex(2, 4, -1), 1);
  // A gallery of one, and the degenerate empty case, stay in range.
  assert.equal(stepIndex(0, 1, 1), 0);
  assert.equal(stepIndex(0, 0, 1), 0);
});

test("swipeArmedX needs distance and horizontal dominance, either direction", () => {
  assert.equal(swipeArmedX(GALLERY_ARM_PX - 1, 0), false);
  assert.equal(swipeArmedX(GALLERY_ARM_PX, 0), true);
  assert.equal(swipeArmedX(-GALLERY_ARM_PX, 0), true);
  // 20px across but 15px down is a diagonal, not a swipe.
  assert.equal(swipeArmedX(20, 15), false);
  assert.equal(swipeArmedX(-20, 15), false);
  assert.equal(swipeArmedX(40, 15), true);
});

test("swipeCancelledX kills a touch that became a vertical scroll", () => {
  assert.equal(swipeCancelledX(0, GALLERY_CANCEL_PX - 1), false);
  assert.equal(swipeCancelledX(0, GALLERY_CANCEL_PX), true);
  assert.equal(swipeCancelledX(0, -GALLERY_CANCEL_PX), true);
  // Still mostly horizontal: alive.
  assert.equal(swipeCancelledX(60, 40), false);
});

test("swipeCommitDir commits on distance in both directions", () => {
  assert.equal(swipeCommitDir(GALLERY_COMMIT_PX, 0, 1000), 1);
  assert.equal(swipeCommitDir(-GALLERY_COMMIT_PX, 0, 1000), -1);
  assert.equal(swipeCommitDir(GALLERY_COMMIT_PX - 1, 0, 1000), 0);
  // Diagonal never commits however far it went.
  assert.equal(swipeCommitDir(200, 150, 1000), 0);
});

test("swipeCommitDir commits a short fast flick but never a tap wobble", () => {
  const short = GALLERY_FLICK_MIN_PX + 1;
  assert.equal(swipeCommitDir(short, 0, 20), 1); // ~1.25 px/ms
  assert.equal(swipeCommitDir(-short, 0, 20), -1);
  assert.equal(swipeCommitDir(short, 0, 400), 0); // same travel, slow: no
  assert.equal(swipeCommitDir(GALLERY_FLICK_MIN_PX - 1, 0, 1), 0);
  assert.equal(swipeCommitDir(short, 0, 0), 0); // no elapsed time, no speed
});

test("swipeActionFor: rightward is back, and backs out of the first image", () => {
  assert.equal(swipeActionFor(1, 2, 5), "prev");
  assert.equal(swipeActionFor(1, 0, 5), "close");
  // A gallery of one behaves exactly like the pre-110 single-image lightbox.
  assert.equal(swipeActionFor(1, 0, 1), "close");
});

test("swipeActionFor: leftward advances and stops at the last image", () => {
  assert.equal(swipeActionFor(-1, 0, 5), "next");
  assert.equal(swipeActionFor(-1, 4, 5), "none");
  assert.equal(swipeActionFor(-1, 0, 1), "none");
  assert.equal(swipeActionFor(0, 2, 5), "none");
});

test("swipeOffsetX damps only where the swipe has nowhere to go", () => {
  assert.equal(swipeOffsetX(90, 0, 3), 90); // rightward at the first: leaving
  assert.equal(swipeOffsetX(-90, 0, 3), -90); // room to advance
  assert.equal(swipeOffsetX(-90, 2, 3), -30); // past the last: rubber band
  assert.equal(swipeOffsetX(-90, 0, 1), -30);
});

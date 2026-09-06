// 111-13: the crop rectangle's arithmetic. The canvas draw needs a DOM and is
// exercised by the UI probe; every rule about where a rectangle may go is
// here, because those are the ones a drag can break in a hundred ways.

import test from "node:test";
import assert from "node:assert/strict";
import {
  FULL_CROP,
  MIN_CROP,
  cropToPixels,
  isFullCrop,
  moveRect,
  rectFromCorners,
  resizeRect,
} from "./crop";

test("a drag becomes a rectangle whichever way it was dragged", () => {
  const downRight = rectFromCorners(10, 20, 60, 80);
  const upLeft = rectFromCorners(60, 80, 10, 20);
  assert.deepEqual(downRight, { x: 10, y: 20, w: 50, h: 60 });
  assert.deepEqual(upLeft, downRight);
});

test("a drag that leaves the picture is clamped, not followed", () => {
  assert.deepEqual(rectFromCorners(-30, -30, 50, 50), { x: 0, y: 0, w: 50, h: 50 });
  assert.deepEqual(rectFromCorners(60, 60, 400, 400), { x: 60, y: 60, w: 40, h: 40 });
});

test("a click is the smallest crop, not an empty one", () => {
  const r = rectFromCorners(40, 40, 40, 40);
  assert.equal(r.w, MIN_CROP);
  assert.equal(r.h, MIN_CROP);
  // And growing to the minimum in a corner must not push it off the edge.
  const corner = rectFromCorners(100, 100, 100, 100);
  assert.ok(corner.x + corner.w <= 100, JSON.stringify(corner));
  assert.ok(corner.y + corner.h <= 100, JSON.stringify(corner));
});

test("moving stops at the edge instead of shrinking or escaping", () => {
  const r = { x: 10, y: 10, w: 40, h: 40 };
  assert.deepEqual(moveRect(r, 5, 5), { x: 15, y: 15, w: 40, h: 40 });
  // Hard left/up: the size is kept, the position pinned.
  assert.deepEqual(moveRect(r, -999, -999), { x: 0, y: 0, w: 40, h: 40 });
  // Hard right/down: flush against the far edge.
  assert.deepEqual(moveRect(r, 999, 999), { x: 60, y: 60, w: 40, h: 40 });
});

test("resizing holds the opposite corner still", () => {
  const r = { x: 20, y: 20, w: 40, h: 40 }; // corners at 20,20 and 60,60
  assert.deepEqual(resizeRect(r, "se", 80, 90), { x: 20, y: 20, w: 60, h: 70 });
  assert.deepEqual(resizeRect(r, "nw", 10, 5), { x: 10, y: 5, w: 50, h: 55 });
  assert.deepEqual(resizeRect(r, "ne", 90, 10), { x: 20, y: 10, w: 70, h: 50 });
  assert.deepEqual(resizeRect(r, "sw", 5, 95), { x: 5, y: 20, w: 55, h: 75 });
});

test("dragging a corner past its opposite flips rather than inverts", () => {
  const r = { x: 20, y: 20, w: 40, h: 40 };
  const flipped = resizeRect(r, "se", 5, 5);
  assert.ok(flipped.w > 0 && flipped.h > 0, JSON.stringify(flipped));
  assert.ok(flipped.x >= 0 && flipped.y >= 0, JSON.stringify(flipped));
});

test("the full picture is recognised, so applying it is a no-op", () => {
  assert.ok(isFullCrop(FULL_CROP));
  assert.ok(!isFullCrop({ x: 0, y: 0, w: 100, h: 90 }));
  assert.ok(!isFullCrop({ x: 5, y: 0, w: 95, h: 100 }));
});

test("percentages become a source rectangle inside the image, never past it", () => {
  assert.deepEqual(cropToPixels({ x: 0, y: 0, w: 100, h: 100 }, 800, 600), {
    sx: 0, sy: 0, sw: 800, sh: 600,
  });
  assert.deepEqual(cropToPixels({ x: 50, y: 50, w: 50, h: 50 }, 800, 600), {
    sx: 400, sy: 300, sw: 400, sh: 300,
  });
  // Rounding at the far edge must not ask for a pixel that isn't there.
  const edge = cropToPixels({ x: 99, y: 99, w: 100, h: 100 }, 801, 601);
  assert.ok(edge.sx + edge.sw <= 801, JSON.stringify(edge));
  assert.ok(edge.sy + edge.sh <= 601, JSON.stringify(edge));
  // And a sliver is still at least one pixel of picture.
  const sliver = cropToPixels({ x: 0, y: 0, w: 0.1, h: 0.1 }, 100, 100);
  assert.ok(sliver.sw >= 1 && sliver.sh >= 1, JSON.stringify(sliver));
});

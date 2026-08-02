import { test } from "node:test";
import assert from "node:assert/strict";
import { pressWandered, LONG_PRESS_SLOP_PX } from "./press";

const origin = { x: 100, y: 100 };

test("a resting hand does not cancel the press", () => {
  assert.equal(pressWandered(origin, origin), false);
  assert.equal(pressWandered(origin, { x: 104, y: 97 }), false);
});

test("the slop is a radius, not a box", () => {
  // Diagonally 10px on each axis is ~14px away -- outside the circle even
  // though each axis alone is within it.
  assert.equal(pressWandered(origin, { x: 110, y: 110 }), true);
  assert.equal(pressWandered(origin, { x: 100, y: 110 }), false);
});

test("a scroll cancels it in either direction", () => {
  assert.equal(pressWandered(origin, { x: 100, y: 100 + LONG_PRESS_SLOP_PX + 1 }), true);
  assert.equal(pressWandered(origin, { x: 100, y: 100 - LONG_PRESS_SLOP_PX - 1 }), true);
});

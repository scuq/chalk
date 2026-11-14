import { test } from "node:test";
import assert from "node:assert/strict";
import { LONG_PRESS_MS, LONG_PRESS_SLOP_PX, pressMoved } from "./long-press";

test("a press holds for half a second, and a move past 10 px is a scroll", () => {
  assert.equal(LONG_PRESS_MS, 500);
  assert.equal(pressMoved(0, 0), false);
  assert.equal(pressMoved(6, 8), false);
  assert.equal(pressMoved(LONG_PRESS_SLOP_PX, 1), true);
  assert.equal(pressMoved(0, -12), true);
});

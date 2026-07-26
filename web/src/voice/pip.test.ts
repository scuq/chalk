import test from "node:test";
import assert from "node:assert/strict";

import { pipWindowSize, pipSupported } from "./pip";

test("pipWindowSize keeps the source aspect ratio when it already fits", () => {
  const { width, height } = pipWindowSize(960, 540);
  assert.equal(width, 960);
  assert.equal(height, 540);
});

test("pipWindowSize scales an oversized source down inside the ceiling", () => {
  const { width, height } = pipWindowSize(3840, 2160);
  assert.ok(width <= 1280 && height <= 800);
  // 16:9 preserved.
  assert.equal(Math.round((width / height) * 100), Math.round((16 / 9) * 100));
});

test("pipWindowSize honours a tall source's ratio, bounded by height", () => {
  const { width, height } = pipWindowSize(1200, 1600);
  assert.equal(height, 800);
  assert.equal(width, 600);
});

test("pipWindowSize falls back to 16:9 for a track with no dimensions yet", () => {
  assert.deepEqual(pipWindowSize(undefined, undefined), { width: 1280, height: 720 });
  assert.deepEqual(pipWindowSize(0, 0), { width: 1280, height: 720 });
});

test("pipSupported is false where the API is absent (node, firefox, safari)", () => {
  assert.equal(pipSupported(), false);
});

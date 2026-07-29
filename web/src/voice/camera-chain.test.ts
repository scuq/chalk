// chalk-web -- camera graph pure helpers (44-10).
//
// The graph itself needs a canvas and a video element, so it is exercised in
// a browser rather than here -- the convention mic-chain already sets. What
// is testable is the sizing decision, which is where the real edge cases sit:
// a source that has no metadata yet, and a source that changes resolution
// underneath a live published track.

import test from "node:test";
import assert from "node:assert/strict";

import { drawSize, frameIntervalMs, sourceFrameRate } from "./camera-chain";

test("frameIntervalMs converts a frame rate to a period", () => {
  assert.equal(frameIntervalMs(30), 33);
  assert.equal(frameIntervalMs(60), 17);
  assert.equal(frameIntervalMs(1), 1000);
});

test("frameIntervalMs falls back for nonsense rates", () => {
  // A zero or negative period would be an interval that never stops firing.
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.equal(frameIntervalMs(bad), 33, `fps=${bad}`);
  }
});

test("sourceFrameRate follows the camera", () => {
  // A 60 fps camera published 60 fps before the canvas sat in the middle;
  // pinning 30 here would be a silent quality change.
  assert.equal(sourceFrameRate(60), 60);
  assert.equal(sourceFrameRate(30), 30);
  assert.equal(sourceFrameRate(24), 24);
});

test("sourceFrameRate defaults when the camera will not say", () => {
  for (const bad of [undefined, NaN, Infinity, 0, -30]) {
    assert.equal(sourceFrameRate(bad), 30, `frameRate=${bad}`);
  }
});

test("sourceFrameRate caps absurd rates", () => {
  assert.equal(sourceFrameRate(120), 60);
});

test("drawSize follows the source once it has dimensions", () => {
  assert.deepEqual(drawSize({ width: 640, height: 360 }, 1280, 720), {
    width: 1280,
    height: 720,
  });
});

test("drawSize keeps the current size while the source reads zero", () => {
  // The window between join and the first frame's metadata. Publishing 0x0
  // here would hand the track degenerate dimensions.
  assert.deepEqual(drawSize({ width: 1280, height: 720 }, 0, 0), {
    width: 1280,
    height: 720,
  });
});

test("drawSize falls back when neither source nor canvas has a size", () => {
  assert.deepEqual(drawSize({ width: 0, height: 0 }, 0, 0), { width: 640, height: 360 });
});

test("drawSize ignores a half-reported source", () => {
  // Engines have been seen reporting width before height during startup.
  assert.deepEqual(drawSize({ width: 640, height: 360 }, 1280, 0), {
    width: 640,
    height: 360,
  });
});

test("drawSize tracks a mid-call resolution change", () => {
  // The adaptive ladder makes the camera renegotiate its own resolution; the
  // canvas has to follow or the published frame gets letterboxed by scaling.
  assert.deepEqual(drawSize({ width: 1280, height: 720 }, 640, 360), {
    width: 640,
    height: 360,
  });
});

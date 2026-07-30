// 52-2: the arithmetic behind background blur.
//
// The compositing needs a GPU and a DOM, so it is not what these cover. What
// they cover is the part that decides how much of the room survives -- the
// threshold and the radius -- which is exactly the part whose bugs look
// plausible on screen and are only obvious in numbers.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MASK_THRESHOLD,
  blurRadius,
  maskToAlpha,
  mediapipeBasePath,
} from "./camera-blur.ts";

function alphaOf(mask: number[]): number[] {
  const out = new Uint8ClampedArray(mask.length * 4);
  maskToAlpha(Float32Array.from(mask), out);
  return Array.from({ length: mask.length }, (_, i) => out[i * 4 + 3]);
}

test("confident foreground is opaque, confident background is transparent", () => {
  assert.deepEqual(alphaOf([1, 0, 1, 0]), [255, 0, 255, 0]);
});

test("the threshold leans towards keeping the person", () => {
  // Not 0.5: blurring someone's hair is a visible artefact ON them, while a
  // sharp patch of room is the failure the feature exists to prevent.
  assert.ok(MASK_THRESHOLD < 0.5);
  assert.deepEqual(alphaOf([MASK_THRESHOLD]), [255]);
});

test("a pixel just below the threshold is background", () => {
  assert.deepEqual(alphaOf([MASK_THRESHOLD - 0.01]), [0]);
});

test("alpha is the only channel written", () => {
  // The composite reads nothing else; writing colour would be wasted work per
  // pixel per frame.
  const out = new Uint8ClampedArray(8);
  maskToAlpha(Float32Array.from([1, 1]), out);
  assert.deepEqual(Array.from(out), [0, 0, 0, 255, 0, 0, 0, 255]);
});

test("blur scales with the frame so it reads the same at any resolution", () => {
  const at360 = blurRadius(360);
  const at720 = blurRadius(720);
  const at1080 = blurRadius(1080);
  assert.ok(at360 < at720 && at720 < at1080);
});

test("blur never gets so small it stops hiding anything", () => {
  // The adaptive ladder (30-8) can drive the camera very low mid-call; a
  // radius that rounded to 1px there would publish a legible room.
  for (const h of [1, 16, 90, 120]) {
    assert.ok(blurRadius(h) >= 4, `height ${h} gave ${blurRadius(h)}`);
  }
});

test("a nonsense frame height still blurs", () => {
  for (const h of [0, -720, NaN, Infinity]) {
    assert.ok(blurRadius(h) >= 4);
  }
});

test("the asset path falls back when the build define is absent", () => {
  // Under the test runner there is no esbuild define. The guard exists so this
  // module can be imported at all -- a bare reference would throw on load.
  assert.equal(mediapipeBasePath(), "/mediapipe");
});

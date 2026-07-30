// 52-1: the background-effect decision.
//
// Two things worth pinning, both of which are wrong in a way nobody would spot
// in a browser: which blur wins when a machine can do both, and what happens to
// the preference on a machine that can do neither.

import { test } from "node:test";
import assert from "node:assert/strict";
import { nativeBlurCapable, planBackgroundBlur, previewSource } from "./camera-effects.ts";

test("a camera offering the choice is capable", () => {
  assert.equal(nativeBlurCapable({ backgroundBlur: [false, true] }), true);
});

test("a camera that is always blurring is capable, not a special case", () => {
  // Some vendor drivers report [true]: blur is on and cannot be turned off.
  // Calling that capable is what stops us stacking our own blur on top.
  assert.equal(nativeBlurCapable({ backgroundBlur: [true] }), true);
});

test("a camera that cannot blur is not capable", () => {
  assert.equal(nativeBlurCapable({ backgroundBlur: [false] }), false);
});

test("a camera that has never heard of the constraint is not capable", () => {
  assert.equal(nativeBlurCapable({}), false);
  assert.equal(nativeBlurCapable(undefined), false);
});

test("the platform's blur beats ours when both are available", () => {
  // Free and better: it happens before the frame reaches us.
  assert.equal(planBackgroundBlur(true, { native: true, processor: true }), "native");
});

test("we do it ourselves when the platform cannot", () => {
  assert.equal(planBackgroundBlur(true, { native: false, processor: true }), "processor");
});

test("wanting blur nothing can produce is off, not an error", () => {
  // The preference stays stored for the machine that can honour it.
  assert.equal(planBackgroundBlur(true, { native: false, processor: false }), "off");
});

test("not wanting blur is off however capable the machine is", () => {
  assert.equal(planBackgroundBlur(false, { native: true, processor: true }), "off");
});

// ---- 52-4: where the settings preview gets its picture --------------------

test("a call publishing video is the preview", () => {
  // The real published frame, already blurred by the real pipeline, for free.
  const s = { camOn: true, localStream: {} as MediaStream };
  assert.equal(previewSource(s), "call");
});

test("a call with the camera off opens its own capture", () => {
  assert.equal(previewSource({ camOn: false, localStream: {} as MediaStream }), "own");
});

test("no call at all opens its own capture", () => {
  assert.equal(previewSource({ camOn: false, localStream: null }), "own");
});

test("camOn with no stream yet is not a preview source", () => {
  // The window between toggling the camera on and the track existing. Showing
  // "call" here would attach null and leave a dead black rectangle.
  assert.equal(previewSource({ camOn: true, localStream: null }), "own");
});

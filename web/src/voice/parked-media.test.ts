// 135-9: the rule for adopting a parked capture, run against fakes.
//
// What is asserted is the decision in canAdopt (age, live tracks, video wanted)
// and that closeParked closes each chain once. No browser is involved.

import test from "node:test";
import assert from "node:assert/strict";

import { PARK_MS, canAdopt, closeParked, type ParkedMedia } from "./parked-media";

interface FakeChain {
  captureLive: boolean;
  closed: number;
  close(): void;
}

function fakeChain(live = true): FakeChain {
  return {
    captureLive: live,
    closed: 0,
    close() {
      this.closed++;
    },
  };
}

const T0 = 1_000_000;

function parked(mic: FakeChain, cam: FakeChain | null): ParkedMedia<FakeChain, FakeChain> {
  return { micChain: mic, cameraChain: cam, parkedAt: T0 };
}

test("canAdopt: a live microphone is adopted for an audio join", () => {
  assert.equal(canAdopt(parked(fakeChain(), null), false, T0 + 1000), true);
});

test("canAdopt: a parked camera does not block an audio join", () => {
  assert.equal(canAdopt(parked(fakeChain(), fakeChain(false)), false, T0 + 1000), true);
});

test("canAdopt: an ended microphone is not adopted", () => {
  assert.equal(canAdopt(parked(fakeChain(false), fakeChain()), true, T0 + 1000), false);
});

test("canAdopt: a video join needs a live parked camera", () => {
  assert.equal(canAdopt(parked(fakeChain(), fakeChain()), true, T0 + 1000), true);
  assert.equal(canAdopt(parked(fakeChain(), null), true, T0 + 1000), false);
  assert.equal(canAdopt(parked(fakeChain(), fakeChain(false)), true, T0 + 1000), false);
});

test("canAdopt: the limit is PARK_MS, inclusive", () => {
  const p = parked(fakeChain(), null);
  assert.equal(canAdopt(p, false, T0 + PARK_MS), true);
  assert.equal(canAdopt(p, false, T0 + PARK_MS + 1), false);
});

test("closeParked closes the two chains once each", () => {
  const mic = fakeChain();
  const cam = fakeChain();
  closeParked(parked(mic, cam));
  assert.equal(mic.closed, 1);
  assert.equal(cam.closed, 1);
});

test("closeParked accepts a capture with no camera", () => {
  const mic = fakeChain();
  closeParked(parked(mic, null));
  assert.equal(mic.closed, 1);
});

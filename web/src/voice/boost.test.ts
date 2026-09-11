import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_PEER_VOLUME,
  boostAvailable,
  boostGain,
  clampPeerVolume,
  elementVolume,
  needsBoost,
  openBoost,
} from "./boost";

test("clampPeerVolume keeps 0..MAX and defaults junk to full", () => {
  assert.equal(MAX_PEER_VOLUME, 2);
  assert.equal(clampPeerVolume(0.5), 0.5);
  assert.equal(clampPeerVolume(1.5), 1.5);
  assert.equal(clampPeerVolume(2), 2);
  assert.equal(clampPeerVolume(3), 2, "over the ceiling clamps, not resets");
  assert.equal(clampPeerVolume(-1), 0);
  // A NaN would silence someone permanently (element.volume = NaN throws).
  assert.equal(clampPeerVolume(NaN), 1);
  assert.equal(clampPeerVolume("2" as never), 1);
  assert.equal(clampPeerVolume(undefined), 1);
});

test("under the ceiling the element carries the level and no graph is needed", () => {
  for (const v of [0, 0.25, 1]) {
    assert.equal(needsBoost(v), false);
    assert.equal(elementVolume(v), v);
    assert.equal(boostGain(v), 1);
  }
});

test("over the ceiling the element sits at 1 and the gain carries the rest", () => {
  for (const v of [1.05, 1.5, 2]) {
    assert.equal(needsBoost(v), true);
    assert.equal(elementVolume(v), 1);
    assert.equal(boostGain(v), v);
  }
  // Past the slider's ceiling the gain is capped with it.
  assert.equal(boostGain(5), 2);
});

test("with no Web Audio the boost reports itself unavailable and opens nothing", () => {
  assert.equal(boostAvailable(), false);
  assert.equal(openBoost({} as unknown as MediaStream, 1.5), null);
});

// The meter's dB mapping. Worth testing because it is the only thing standing
// between a dragged handle and a stored gate threshold: get the inverse wrong
// and the mic opens at a level the user never picked, with the meter drawing
// the value they DID pick -- a disagreement that is unfalsifiable by eye.

import { test } from "node:test";
import assert from "node:assert/strict";
import { METER_FLOOR_DB, dbLabel, meterPos, meterRms, rmsToDb } from "./meter-scale.ts";

test("rmsToDb clamps to the meter's range", () => {
  assert.equal(rmsToDb(0), METER_FLOOR_DB);
  assert.equal(rmsToDb(-1), METER_FLOOR_DB, "a negative amplitude is not a level");
  assert.equal(rmsToDb(NaN), METER_FLOOR_DB);
  assert.equal(rmsToDb(0.000001), METER_FLOOR_DB, "below the floor pins to the floor");
  assert.equal(rmsToDb(1), 0);
  assert.equal(rmsToDb(4), 0, "over full scale pins to 0 dB");
  assert.equal(Math.round(rmsToDb(0.1)), -20);
});

test("meterPos spans 0..1 across the floor", () => {
  assert.equal(meterPos(0), 0);
  assert.equal(meterPos(1), 1);
  // The point of the whole exercise: a speaking voice lands mid-meter instead
  // of in the leftmost tenth, where it sat on a linear scale.
  const speech = meterPos(0.1);
  assert.ok(speech > 0.6 && speech < 0.7, `speech should sit mid-meter, got ${speech}`);
});

test("meterRms inverts meterPos", () => {
  for (const rms of [0, 0.01, 0.08, 0.2, 0.5, 1]) {
    const back = meterRms(meterPos(rms));
    assert.ok(Math.abs(back - rms) < 1e-9, `${rms} round-tripped to ${back}`);
  }
});

test("anything at or under the floor collapses to zero", () => {
  // 0.001 RMS is exactly -60 dB. Below the floor there is no travel left to
  // distinguish levels, and a threshold pinned there means "any signal at all".
  assert.equal(meterPos(0.001), 0);
  assert.equal(meterRms(meterPos(0.001)), 0);
});

test("meterRms clamps a drag past either end of the track", () => {
  assert.equal(meterRms(-0.5), 0);
  assert.equal(meterRms(1.5), 1);
});

test("the mapping is monotonic", () => {
  let prev = -1;
  for (let pos = 0; pos <= 1.0001; pos += 0.05) {
    const rms = meterRms(pos);
    assert.ok(rms > prev, `pos ${pos} gave ${rms}, not above ${prev}`);
    prev = rms;
  }
});

test("dbLabel names the floor rather than printing -60 dB", () => {
  assert.equal(dbLabel(0), "silence");
  assert.equal(dbLabel(0.1), "-20 dB");
  assert.equal(dbLabel(1), "0 dB");
});

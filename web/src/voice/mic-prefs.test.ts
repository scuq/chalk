// Microphone capture prefs: the parsing rules and the constraint mapping.
//
// This entry is in localStorage, so it is user-editable, it survives upgrades,
// and a crashed tab can leave it half-written. normalize has to be total over
// all of that. The failure mode that matters here is a stored value that either
// throws on load (no profile panel, no voice join) or that produces constraints
// getUserMedia rejects -- both of which read to the user as "voice is broken".

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MIC_PREFS,
  MAX_GAIN,
  MIN_GAIN,
  micConstraints,
  needsRecapture,
  normalizeMicPrefs,
} from "./mic-prefs.ts";

test("normalize keeps a valid pref untouched", () => {
  const prefs = {
    deviceId: "abc123",
    gain: 1.4,
    echoCancellation: false,
    noiseSuppression: true,
    autoGainControl: false,
  };
  assert.deepEqual(normalizeMicPrefs(prefs), prefs);
});

test("normalize falls back on junk input", () => {
  for (const junk of [null, undefined, 42, "loud", [], true]) {
    assert.deepEqual(normalizeMicPrefs(junk), DEFAULT_MIC_PREFS);
  }
});

test("normalize defaults to the system default device at unity gain", () => {
  const p = normalizeMicPrefs({});
  assert.equal(p.deviceId, "", "empty means system default");
  assert.equal(p.gain, 1);
  assert.equal(p.echoCancellation, true);
  assert.equal(p.noiseSuppression, true);
  assert.equal(p.autoGainControl, true);
});

test("normalize keeps the good half of a partially bad pref", () => {
  const p = normalizeMicPrefs({ deviceId: "keep-me", gain: "loud", echoCancellation: 1 });
  assert.equal(p.deviceId, "keep-me");
  assert.equal(p.gain, DEFAULT_MIC_PREFS.gain);
  assert.equal(p.echoCancellation, true, "a non-boolean must fall back, not read as truthy");
});

test("normalize takes only booleans for the processing flags", () => {
  const p = normalizeMicPrefs({
    echoCancellation: "yes",
    noiseSuppression: false,
    autoGainControl: 0,
  });
  assert.equal(p.echoCancellation, DEFAULT_MIC_PREFS.echoCancellation);
  assert.equal(p.noiseSuppression, false, "an explicit false must survive");
  assert.equal(p.autoGainControl, DEFAULT_MIC_PREFS.autoGainControl, "0 is not false");
});

test("normalize clamps rather than rejects out-of-range gains", () => {
  assert.equal(normalizeMicPrefs({ gain: -3 }).gain, MIN_GAIN);
  assert.equal(normalizeMicPrefs({ gain: 99 }).gain, MAX_GAIN);
  assert.equal(normalizeMicPrefs({ gain: NaN }).gain, DEFAULT_MIC_PREFS.gain);
  assert.equal(normalizeMicPrefs({ gain: Infinity }).gain, DEFAULT_MIC_PREFS.gain);
});

test("normalize accepts a numeric string gain", () => {
  assert.equal(normalizeMicPrefs({ gain: "1.75" }).gain, 1.75);
});

test("normalize takes only a string device id", () => {
  assert.equal(normalizeMicPrefs({ deviceId: 5 }).deviceId, "");
  assert.equal(normalizeMicPrefs({ deviceId: null }).deviceId, "");
});

test("normalize drops keys this build does not know", () => {
  const p = normalizeMicPrefs({ gain: 1, vadThreshold: 0.3 });
  assert.deepEqual(Object.keys(p).sort(), Object.keys(DEFAULT_MIC_PREFS).sort());
});

test("constraints omit the device id when it is the system default", () => {
  const c = micConstraints(DEFAULT_MIC_PREFS);
  assert.equal("deviceId" in c, false, "an exact empty id matches no device at all");
});

test("constraints carry a chosen device id", () => {
  const c = micConstraints({ ...DEFAULT_MIC_PREFS, deviceId: "yeti" });
  assert.equal(c.deviceId, "yeti");
});

test("constraints map all three processing flags through", () => {
  for (const on of [true, false]) {
    const c = micConstraints({
      ...DEFAULT_MIC_PREFS,
      echoCancellation: on,
      noiseSuppression: on,
      autoGainControl: on,
    });
    assert.equal(c.echoCancellation, on);
    assert.equal(c.noiseSuppression, on);
    assert.equal(c.autoGainControl, on);
  }
});

test("constraints never carry gain -- it is ours, not the browser's", () => {
  const c = micConstraints({ ...DEFAULT_MIC_PREFS, gain: 1.8 }) as Record<string, unknown>;
  assert.equal("gain" in c, false);
});

test("gain alone never forces a recapture", () => {
  const a = DEFAULT_MIC_PREFS;
  assert.equal(needsRecapture(a, { ...a, gain: 1.9 }), false);
  assert.equal(needsRecapture(a, a), false);
});

test("the device and every processing flag force a recapture", () => {
  const a = DEFAULT_MIC_PREFS;
  assert.equal(needsRecapture(a, { ...a, deviceId: "other" }), true);
  assert.equal(needsRecapture(a, { ...a, echoCancellation: false }), true);
  assert.equal(needsRecapture(a, { ...a, noiseSuppression: false }), true);
  assert.equal(needsRecapture(a, { ...a, autoGainControl: false }), true);
});

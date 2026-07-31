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
  MAX_HOLD_MS,
  MIN_GAIN,
  micConstraints,
  needsRecapture,
  normalizeMicPrefs,
  sameSyncedMicPrefs,
  syncedMicPrefs,
} from "./mic-prefs.ts";

test("normalize keeps a valid pref untouched", () => {
  const prefs = {
    deviceId: "abc123",
    deviceLabel: "scuq's AirPods Pro",
    gain: 1.4,
    echoCancellation: false,
    noiseSuppression: true,
    autoGainControl: false,
    mode: "ptt" as const,
    vadOpen: 0.3,
    vadClose: 0.1,
    holdMs: 250,
    keyTalk: "KeyV",
    keyMute: "KeyM",
    keyDeafen: "KeyD",
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
  // 44-8: AGC is the one processing flag that is off out of the box -- it
  // raises the room to voice level in every pause, which is both the "noise
  // suppression does nothing" complaint and a moving floor under the VAD marks.
  assert.equal(p.autoGainControl, false);
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

test("normalize defaults to the mode that changes nothing", () => {
  // An upgrade must not silently start gating microphones with thresholds
  // nobody has calibrated -- see the comment on DEFAULT_MIC_PREFS.
  assert.equal(normalizeMicPrefs({}).mode, "continuous");
});

test("normalize rejects a mode this build cannot run", () => {
  assert.equal(normalizeMicPrefs({ mode: "telepathy" }).mode, "continuous");
  assert.equal(normalizeMicPrefs({ mode: 3 }).mode, "continuous");
  for (const m of ["continuous", "vad", "ptt", "ptm"]) {
    assert.equal(normalizeMicPrefs({ mode: m }).mode, m, `${m} must round-trip`);
  }
});

test("normalize never lets the silence floor rise above the speech threshold", () => {
  // Inverted thresholds give a gate that can open but never close.
  const p = normalizeMicPrefs({ vadOpen: 0.2, vadClose: 0.9 });
  assert.equal(p.vadOpen, 0.2);
  assert.equal(p.vadClose, 0.2, "clamped down to meet it");
});

test("normalize clamps the thresholds and the hold time", () => {
  assert.equal(normalizeMicPrefs({ vadOpen: 5 }).vadOpen, 1);
  assert.equal(normalizeMicPrefs({ vadOpen: -1 }).vadOpen, 0);
  assert.equal(normalizeMicPrefs({ holdMs: -50 }).holdMs, 0);
  assert.equal(normalizeMicPrefs({ holdMs: 99999 }).holdMs, MAX_HOLD_MS);
});

test("normalize keeps a long device id but rejects an absurd keybind", () => {
  const long = "a".repeat(120);
  assert.equal(normalizeMicPrefs({ deviceId: long }).deviceId, long, "ids are long hashes");
  assert.equal(normalizeMicPrefs({ keyTalk: long }).keyTalk, "", "a key code is short");
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
  // Flipped ON, since 44-8 made off the default: comparing a default against
  // itself would prove nothing.
  assert.equal(needsRecapture(a, { ...a, autoGainControl: true }), true);
});

// 44-4: the account/machine split. The bug this guards against is a deviceId
// riding along to the server and a second machine then trying to open a
// microphone that only exists on the first one.

test("the synced half carries every tuning field but not the device", () => {
  const synced = syncedMicPrefs({
    ...DEFAULT_MIC_PREFS,
    deviceId: "local-hash",
    deviceLabel: "USB Interface",
    gain: 1.6,
  });
  assert.equal("deviceId" in synced, false, "the device never leaves this machine");
  assert.equal("deviceLabel" in synced, false, "63-3: nor does its label");
  assert.equal(synced.gain, 1.6);
  // Every other field of MicPrefs is expected to sync; a new one added without
  // a decision about it should fail here rather than silently stay local.
  const expected = Object.keys(DEFAULT_MIC_PREFS)
    .filter((k) => k !== "deviceId" && k !== "deviceLabel")
    .sort();
  assert.deepEqual(Object.keys(synced).sort(), expected);
});

test("comparing the synced half ignores the device", () => {
  const a = DEFAULT_MIC_PREFS;
  assert.equal(sameSyncedMicPrefs(a, { ...a, deviceId: "other" }), true, "device is not synced");
  assert.equal(sameSyncedMicPrefs(a, { ...a, gain: 1.5 }), false);
  assert.equal(sameSyncedMicPrefs(a, { ...a, keyMute: "KeyM" }), false);
  assert.equal(sameSyncedMicPrefs(a, { ...a, mode: "ptt" }), false);
});

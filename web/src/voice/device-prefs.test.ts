// The camera/output device prefs. Same failure mode as mic-prefs: this entry
// is in localStorage, so it is user-editable and survives upgrades, and a
// stored value that produces constraints getUserMedia rejects reads to the user
// as "my camera is broken".

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DEVICE_PREFS,
  cameraConstraints,
  normalizeDevicePrefs,
} from "./device-prefs.ts";

test("normalize keeps a valid pref untouched", () => {
  const prefs = { cameraId: "cam-1", outputId: "spk-2" };
  assert.deepEqual(normalizeDevicePrefs(prefs), prefs);
});

test("normalize falls back on junk input", () => {
  for (const junk of [null, undefined, 42, "loud", [], true]) {
    assert.deepEqual(normalizeDevicePrefs(junk), DEFAULT_DEVICE_PREFS);
  }
});

test("normalize keeps the good half of a partially bad pref", () => {
  const p = normalizeDevicePrefs({ cameraId: "keep-me", outputId: 7 });
  assert.equal(p.cameraId, "keep-me");
  assert.equal(p.outputId, "");
});

test("both devices default to the system default", () => {
  const p = normalizeDevicePrefs({});
  assert.equal(p.cameraId, "");
  assert.equal(p.outputId, "");
});

test("an unset camera asks for any camera, not for the empty device", () => {
  // The bug this guards: `{deviceId: ""}` is an exact match against no device,
  // which fails the capture outright instead of meaning "system default".
  assert.equal(cameraConstraints(DEFAULT_DEVICE_PREFS), true);
});

test("a chosen camera is a hint, not a requirement", () => {
  const c = cameraConstraints({ cameraId: "cam-1", outputId: "" });
  // Plain deviceId rather than {exact}: a camera unplugged since it was chosen
  // must degrade to another one rather than fail the join.
  assert.deepEqual(c, { deviceId: "cam-1" });
});

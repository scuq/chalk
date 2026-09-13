// 126-2: fmtDuration, split out of VoiceDock so the zucker call bar's clock
// can be unit-tested without importing the session, pip and boost modules
// VoiceDock pulls in.

import { test } from "node:test";
import assert from "node:assert/strict";

import { fmtDuration } from "./duration";

test("fmtDuration shows minutes and seconds under an hour", () => {
  assert.equal(fmtDuration(0), "00:00");
  assert.equal(fmtDuration(59_999), "00:59");
  assert.equal(fmtDuration(754_000), "12:34");
});

test("fmtDuration adds the hour once there is one", () => {
  assert.equal(fmtDuration(3_600_000), "1:00:00");
  assert.equal(fmtDuration(45_296_000), "12:34:56");
});

test("fmtDuration clamps a clock that ran backwards", () => {
  assert.equal(fmtDuration(-5_000), "00:00");
});

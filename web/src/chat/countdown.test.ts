// Tests for src/chat/countdown.ts (80-14): formatting and boundaries.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { formatCountdown, countdownTickMs, countdownUrgent } from "./countdown";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

test("formatCountdown boundaries", () => {
  assert.equal(formatCountdown(0), "0:00");
  assert.equal(formatCountdown(-5 * SEC), "0:00");
  assert.equal(formatCountdown(SEC), "0:01");
  assert.equal(formatCountdown(59 * SEC), "0:59");
  assert.equal(formatCountdown(90 * SEC), "1:30");
  assert.equal(formatCountdown(59 * MIN + 59 * SEC), "59:59");
  // The hour boundary flips to the coarse form.
  assert.equal(formatCountdown(HOUR), "1h");
  assert.equal(formatCountdown(HOUR + 30 * MIN), "1h 30m");
  assert.equal(formatCountdown(47 * HOUR + 59 * MIN), "47h 59m");
  // 48 h flips to days (floor: "2d" until the third full day).
  assert.equal(formatCountdown(48 * HOUR), "2d");
  assert.equal(formatCountdown(30 * DAY), "30d");
});

test("formatCountdown rounds partial seconds up, never down to 0:00 early", () => {
  assert.equal(formatCountdown(500), "0:01");
  assert.equal(formatCountdown(59_500), "1:00");
});

test("countdownTickMs: 1 Hz inside the last hour, minutely beyond", () => {
  assert.equal(countdownTickMs(30 * MIN), 1000);
  assert.equal(countdownTickMs(HOUR), 1000);
  assert.equal(countdownTickMs(HOUR + 1), 60_000);
  assert.equal(countdownTickMs(3 * DAY), 60_000);
});

test("countdownUrgent: the last five minutes", () => {
  assert.equal(countdownUrgent(5 * MIN), true);
  assert.equal(countdownUrgent(5 * MIN + 1), false);
  assert.equal(countdownUrgent(10 * SEC), true);
});

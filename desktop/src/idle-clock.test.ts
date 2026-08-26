// 104-5: locked is derived, never remembered.

import { test } from "node:test";
import assert from "node:assert/strict";
import { STALE_LOCK_MS, formatReading, readIdle, readingChanged } from "./idle-clock";
import type { IdleReading, OSIdleState } from "./idle-clock";

function deps(idleSeconds: number, idleState: OSIdleState) {
  return { idleSeconds: () => idleSeconds, idleState: () => idleState };
}

test("a plain reading passes idle time through and is not locked", () => {
  const r = readIdle(deps(42, "active"), false);
  assert.deepEqual(r, { idleMs: 42_000, locked: false, osState: "active", eventLocked: false });
});

test("the lock-screen edge is immediate whatever the OS clock says", () => {
  assert.equal(readIdle(deps(0, "active"), true).locked, true);
  assert.equal(readIdle(deps(0, "unknown"), true).locked, true);
});

test("an OS lock counts once input has been absent for STALE_LOCK_MS", () => {
  const secs = STALE_LOCK_MS / 1000;
  assert.equal(readIdle(deps(secs, "locked"), false).locked, true);
  assert.equal(readIdle(deps(secs * 10, "locked"), false).locked, true);
});

test("an OS lock with recent input is a stale latch and is ignored", () => {
  // The macOS wake case: Chromium still says locked, the user is typing.
  assert.equal(readIdle(deps(2, "locked"), false).locked, false);
  assert.equal(readIdle(deps(STALE_LOCK_MS / 1000 - 1, "locked"), false).locked, false);
});

test("unlock-screen clears even while the OS still answers locked", () => {
  // The race idle.ts used to lose: its own unlock handler read the OS state
  // before Chromium's observer of the same notification had run.
  const before = readIdle(deps(3600, "locked"), true);
  assert.equal(before.locked, true);
  const after = readIdle(deps(1, "locked"), false);
  assert.equal(after.locked, false);
});

test("nothing is remembered between reads", () => {
  // A screensaver without a password: locked once, then it stops and no
  // unlock-screen ever comes. The next read must simply say unlocked.
  assert.equal(readIdle(deps(600, "locked"), false).locked, true);
  assert.equal(readIdle(deps(0, "active"), false).locked, false);
});

test("garbage from the OS reads as zero idle", () => {
  assert.equal(readIdle(deps(Number.NaN, "active"), false).idleMs, 0);
  assert.equal(readIdle(deps(-5, "active"), false).idleMs, 0);
});

test("readingChanged ignores the idle clock alone", () => {
  const a: IdleReading = { idleMs: 1000, locked: false, osState: "active", eventLocked: false };
  assert.equal(readingChanged(null, a), true);
  assert.equal(readingChanged(a, { ...a, idleMs: 16_000 }), false);
  assert.equal(readingChanged(a, { ...a, osState: "idle" }), true);
  assert.equal(readingChanged(a, { ...a, locked: true }), true);
  assert.equal(readingChanged(a, { ...a, eventLocked: true }), true);
});

test("formatReading shows every input and the verdict", () => {
  const r: IdleReading = { idleMs: 3_600_000, locked: false, osState: "locked", eventLocked: false };
  assert.equal(formatReading("tick", r), "tick: os=locked idle=3600s events=unlocked -> locked=false");
});

// The away rules.
//
// Every one of these is a bug someone would report about their own dot or
// someone else's: away while you are sitting there reading, online for the
// twenty minutes you spent making coffee, a dot that flickers on every
// alt-tab. The precedence between the rules matters as much as the rules --
// two of them can be true at once and the wrong winner is a visible bug.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AWAY_AFTER_HIDDEN_MS,
  IDLE_AFTER_FOCUSED_MS,
  IDLE_AFTER_UNFOCUSED_MS,
  decideIdle,
  type IdleInput,
} from "./idle.ts";

const NOW = 1_000_000_000;

// Present and correct: visible, focused, just touched the keyboard, and no
// IdleDetector in the picture. Each test breaks exactly the one thing it is
// about.
function input(over: Partial<IdleInput> = {}): IdleInput {
  return {
    now: NOW,
    lastActivityAt: NOW,
    tabVisible: true,
    windowFocused: true,
    hiddenSince: undefined,
    systemIdle: undefined,
    screenLocked: undefined,
    awayAfterHiddenMs: AWAY_AFTER_HIDDEN_MS,
    idleAfterUnfocusedMs: IDLE_AFTER_UNFOCUSED_MS,
    idleAfterFocusedMs: IDLE_AFTER_FOCUSED_MS,
    ...over,
  };
}

test("someone at the keyboard is active", () => {
  assert.deepEqual(decideIdle(input()), { idle: false, reason: "active" });
});

// Rule 1.
test("a locked screen is away with no grace period", () => {
  assert.deepEqual(decideIdle(input({ screenLocked: true, lastActivityAt: NOW })), {
    idle: true,
    reason: "screen_locked",
  });
});

// Rule 2.
test("system-wide idle is away", () => {
  // No in-page timeout is involved: the API's own threshold is already at
  // least 60s of no input to any application.
  assert.deepEqual(decideIdle(input({ systemIdle: true, lastActivityAt: NOW })), {
    idle: true,
    reason: "system_idle",
  });
});

// Rule 3.
test("a hidden tab goes away once, after the grace period", () => {
  const hidden = (ago: number) =>
    decideIdle(input({ tabVisible: false, hiddenSince: NOW - ago }));
  // Alt-tabbing for a few seconds must not move the dot.
  assert.equal(hidden(AWAY_AFTER_HIDDEN_MS - 1).idle, false);
  assert.deepEqual(hidden(AWAY_AFTER_HIDDEN_MS), { idle: true, reason: "hidden" });
});

test("a visible tab ignores a stale hiddenSince", () => {
  // Belt and braces: the watcher clears hiddenSince on reveal, and the rule
  // checks tabVisible as well, so a leaked timestamp cannot strand the dot.
  assert.equal(decideIdle(input({ tabVisible: true, hiddenSince: NOW - 3_600_000 })).idle, false);
});

// Rule 4 -- the reason the Chromium layer is worth having at all.
test("known system activity beats every in-page timeout", () => {
  // Reading a long thread for twenty minutes without touching anything, with
  // the OS confirming input is happening somewhere.
  assert.deepEqual(
    decideIdle(input({ systemIdle: false, lastActivityAt: NOW - 20 * 60_000 })),
    { idle: false, reason: "system_active" },
  );
  // Same, with chalk merely visible behind another window we are typing in.
  assert.deepEqual(
    decideIdle(
      input({ systemIdle: false, windowFocused: false, lastActivityAt: NOW - 20 * 60_000 }),
    ),
    { idle: false, reason: "system_active" },
  );
});

test("a locked screen still wins over known system activity", () => {
  // screenState and userState are independent; "active" arriving alongside a
  // lock would otherwise keep someone online through their lock screen.
  assert.equal(decideIdle(input({ systemIdle: false, screenLocked: true })).idle, true);
});

test("an unknown system state is not a known-active one", () => {
  // The whole reason systemIdle is optional: undefined must fall through to
  // the in-page rules, not be read as "the OS says you are here".
  assert.deepEqual(decideIdle(input({ lastActivityAt: NOW - IDLE_AFTER_FOCUSED_MS })), {
    idle: true,
    reason: "no_input",
  });
});

// Rule 5.
test("chalk on screen while you work elsewhere goes away", () => {
  const unfocused = (ago: number) =>
    decideIdle(input({ windowFocused: false, lastActivityAt: NOW - ago }));
  assert.equal(unfocused(IDLE_AFTER_UNFOCUSED_MS - 1).idle, false);
  assert.deepEqual(unfocused(IDLE_AFTER_UNFOCUSED_MS), {
    idle: true,
    reason: "unfocused_idle",
  });
});

// Rule 6.
test("a focused window is given much longer than an unfocused one", () => {
  const focused = (ago: number) => decideIdle(input({ lastActivityAt: NOW - ago }));
  // Past the unfocused threshold, nowhere near the focused one: a window in
  // front of you is weak evidence of absence, and calling this away is what
  // would make someone's dot lie while they read.
  assert.equal(focused(IDLE_AFTER_UNFOCUSED_MS).idle, false);
  assert.equal(focused(IDLE_AFTER_FOCUSED_MS - 1).idle, false);
  assert.deepEqual(focused(IDLE_AFTER_FOCUSED_MS), { idle: true, reason: "no_input" });
});

test("a slept or frozen tab resolves on the clock, not on ticks", () => {
  // Background tabs get their timers clamped to about one a minute, frozen
  // tabs get none at all, and a closed laptop lid gives none for hours. The
  // verdict has to come out of the timestamp difference alone, so however few
  // intervals actually fired is irrelevant.
  const past = NOW + IDLE_AFTER_FOCUSED_MS + 60_000;
  assert.equal(decideIdle(input({ now: past })).idle, true);
  assert.equal(
    decideIdle(input({ now: past, windowFocused: false })).reason,
    "unfocused_idle",
  );
});

test("thresholds are read from the input, not from the module", () => {
  // They are passed in so a test can pin them and so a future per-device
  // override does not have to reach into module state.
  assert.equal(decideIdle(input({ lastActivityAt: NOW - 5_000, idleAfterFocusedMs: 1_000 })).idle, true);
  assert.equal(
    decideIdle(input({ tabVisible: false, hiddenSince: NOW - 5_000, awayAfterHiddenMs: 60_000 }))
      .idle,
    false,
  );
});

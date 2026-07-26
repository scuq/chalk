// The suppression rules from docs/notification-sounds.md.
//
// These are the rules that decide whether chalk is pleasant or
// intolerable, and every one of them is a bug someone would report:
// noise for the channel you're reading, a burst on a busy morning, a
// sound after you asked for silence.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  decideSound,
  MIN_GAP_ANY_MS,
  MIN_GAP_CATEGORY_MS,
  type GateInput,
} from "./gate.ts";
import { SOUND_CATEGORIES, type SoundPrefs } from "./types.ts";

// A pref set where everything is audible, so each test silences exactly
// the one thing it is about. Deliberately not DEFAULT_SOUND_PREFS: these
// tests are about the rules, and they shouldn't start failing because a
// default was changed.
const ALL_ON: SoundPrefs = {
  master: true,
  volume: 0.5,
  dnd: false,
  categories: Object.fromEntries(SOUND_CATEGORIES.map((c) => [c, true])) as SoundPrefs["categories"],
};

const MASTER_OFF: SoundPrefs = { ...ALL_ON, master: false };

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    category: "message",
    prefs: ALL_ON,
    unlocked: true,
    tabVisible: false,
    userIdle: false,
    isRelevantSurfaceOpen: false,
    now: 1_000_000,
    lastAnyAt: undefined,
    lastByCategory: {},
    ...over,
  };
}

test("a wanted sound in a hidden tab plays", () => {
  assert.equal(decideSound(input()), "play");
});

test("the master switch silences everything", () => {
  for (const c of SOUND_CATEGORIES) {
    assert.equal(decideSound(input({ category: c, prefs: MASTER_OFF })), "master_off");
  }
});

test("a category the user turned off stays off", () => {
  const prefs = { ...ALL_ON, categories: { ...ALL_ON.categories, mention: false } };
  assert.equal(decideSound(input({ category: "mention", prefs })), "category_off");
  assert.equal(decideSound(input({ category: "dm", prefs })), "play");
});

// Rule 1.
test("no sound for a surface you are already looking at", () => {
  assert.equal(
    decideSound(input({ tabVisible: true, isRelevantSurfaceOpen: true })),
    "already_watching",
  );
});

test("rule 1 needs both halves", () => {
  // Right channel, but the window is behind something else.
  assert.equal(decideSound(input({ tabVisible: false, isRelevantSurfaceOpen: true })), "play");
  // Focused, but reading a different channel.
  assert.equal(decideSound(input({ tabVisible: true, isRelevantSurfaceOpen: false })), "play");
});

test("a channel on screen with nobody in front of it still makes a noise", () => {
  // 45-3. The whole point of the idle signal reaching the gate: the window
  // being up is not evidence anyone read the message. This is the coffee-break
  // case, and it used to be the one time chalk went quiet.
  assert.equal(
    decideSound(input({ tabVisible: true, userIdle: true, isRelevantSurfaceOpen: true })),
    "play",
  );
});

test("idle does not override the pref checks", () => {
  // Being away is a reason to speak up, never a reason to ignore someone who
  // asked for silence.
  const ctx = { tabVisible: true, userIdle: true, isRelevantSurfaceOpen: true };
  assert.equal(decideSound(input({ ...ctx, prefs: MASTER_OFF })), "master_off");
  assert.equal(decideSound(input({ ...ctx, prefs: { ...ALL_ON, dnd: true } })), "dnd");
});

test("rule 1 applies to system categories too", () => {
  // A disconnect while you're watching the window is already in the
  // status bar; making a noise about it is redundant.
  for (const c of ["connect", "disconnect", "error", "send_confirm"] as const) {
    assert.equal(
      decideSound(input({ category: c, tabVisible: true, isRelevantSurfaceOpen: true })),
      "already_watching",
    );
  }
});

// Rule 2.
test("do not disturb silences everything", () => {
  const prefs = { ...ALL_ON, dnd: true };
  for (const c of SOUND_CATEGORIES) {
    assert.equal(decideSound(input({ category: c, prefs })), "dnd");
  }
});

// Rule 3.
test("two sounds inside the global floor collapse to one", () => {
  const now = 1_000_000;
  assert.equal(decideSound(input({ now, lastAnyAt: now - (MIN_GAP_ANY_MS - 1) })), "rate_any");
  assert.equal(decideSound(input({ now, lastAnyAt: now - MIN_GAP_ANY_MS })), "play");
});

test("the same category is held back longer than the global floor", () => {
  const now = 1_000_000;
  // Past the global floor, still inside the per-category one.
  const justOverGlobal = now - MIN_GAP_ANY_MS - 1;
  assert.equal(
    decideSound(
      input({
        now,
        category: "message",
        lastAnyAt: justOverGlobal,
        lastByCategory: { message: justOverGlobal },
      }),
    ),
    "rate_category",
  );
  // A different category at the same instant is fine -- that's the point
  // of having two limits.
  assert.equal(
    decideSound(
      input({
        now,
        category: "mention",
        lastAnyAt: justOverGlobal,
        lastByCategory: { message: justOverGlobal },
      }),
    ),
    "play",
  );
});

test("the per-category floor releases exactly on time", () => {
  const now = 1_000_000;
  const at = (ago: number) => ({
    now,
    lastAnyAt: now - MIN_GAP_ANY_MS,
    lastByCategory: { message: now - ago },
  });
  assert.equal(decideSound(input(at(MIN_GAP_CATEGORY_MS - 1))), "rate_category");
  assert.equal(decideSound(input(at(MIN_GAP_CATEGORY_MS))), "play");
});

test("never-played is not the same as played-at-zero", () => {
  // Under a performance.now() clock the app starts near t=0. If "never"
  // were stored as 0, every sound in the first two seconds after load
  // would be swallowed.
  assert.equal(decideSound(input({ now: 500, lastAnyAt: undefined })), "play");
  assert.equal(decideSound(input({ now: 500, lastByCategory: {} })), "play");
});

// Rule 4.
test("nothing plays before the user has interacted with the page", () => {
  assert.equal(decideSound(input({ unlocked: false })), "locked");
});

test("the pref checks are reported ahead of the lock", () => {
  // "locked" is decided last on purpose: the caller only records a
  // timestamp when the verdict is "play", so a burst of dropped sounds
  // before the first click must not delay the first real one. A category
  // the user switched off should still say so rather than blaming the
  // lock, which is what makes the verdict useful for debugging.
  assert.equal(decideSound(input({ unlocked: false, prefs: MASTER_OFF })), "master_off");
});

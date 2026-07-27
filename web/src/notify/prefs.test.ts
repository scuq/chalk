// Notification sound prefs: the parsing rules.
//
// This entry is in localStorage, which means it is user-editable, it
// survives upgrades, and it can be left half-written by a crashed tab.
// normalize has to be total over all of that -- the failure mode we care
// about is a stored value that either throws on load (no app) or that
// turns every category on at full volume (a noise complaint).
//
// Since 50-2 the categories here are the machine noises only; the chat
// and event categories are the rules engine's business (rules.test.ts).
// Normalize dropping them from a v1-shaped entry IS the v1 -> v2
// migration, so that behaviour is pinned below.

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSoundPrefs } from "./prefs.ts";
import {
  DEFAULT_SOUND_PREFS,
  MACHINE_CATEGORIES,
  MAX_VOLUME,
  MIN_VOLUME,
  type MachineCategory,
} from "./types.ts";

test("normalize keeps a valid pref untouched", () => {
  const prefs = {
    master: true,
    volume: 0.7,
    dnd: true,
    categories: { ...DEFAULT_SOUND_PREFS.categories, presence: true },
  };
  assert.deepEqual(normalizeSoundPrefs(prefs), prefs);
});

test("normalize falls back on junk input", () => {
  for (const junk of [null, undefined, 42, "loud", [], true]) {
    assert.deepEqual(normalizeSoundPrefs(junk), DEFAULT_SOUND_PREFS);
  }
});

test("normalize defaults to silent machinery, audible errors", () => {
  const p = normalizeSoundPrefs({});
  assert.equal(p.master, true);
  assert.equal(p.dnd, false);
  assert.equal(p.categories.error, true, "a failed send should be heard");
  for (const c of ["presence", "connect", "disconnect", "send_confirm"] as const) {
    assert.equal(p.categories[c], false, `${c} reports on chalk, not on people -- keep it quiet`);
  }
});

test("normalize keeps the good half of a partially bad pref", () => {
  const p = normalizeSoundPrefs({ master: true, volume: "loud", dnd: 1 });
  assert.equal(p.master, true);
  assert.equal(p.volume, DEFAULT_SOUND_PREFS.volume);
  assert.equal(p.dnd, false, "a non-boolean dnd must not read as truthy");
});

test("normalize clamps rather than rejects out-of-range volumes", () => {
  assert.equal(normalizeSoundPrefs({ volume: -1 }).volume, MIN_VOLUME);
  assert.equal(normalizeSoundPrefs({ volume: 99 }).volume, MAX_VOLUME);
  assert.equal(normalizeSoundPrefs({ volume: NaN }).volume, DEFAULT_SOUND_PREFS.volume);
});

test("normalize accepts a numeric string volume", () => {
  assert.equal(normalizeSoundPrefs({ volume: "0.25" }).volume, 0.25);
});

test("normalize fills in every category, whatever was stored", () => {
  for (const raw of [{}, { categories: null }, { categories: [] }, { categories: "all" }]) {
    const p = normalizeSoundPrefs(raw);
    for (const c of MACHINE_CATEGORIES) {
      assert.equal(typeof p.categories[c], "boolean", `${c} must be present`);
    }
  }
});

test("normalize takes only booleans for a category", () => {
  const p = normalizeSoundPrefs({ categories: { presence: "yes", connect: false } });
  assert.equal(p.categories.presence, DEFAULT_SOUND_PREFS.categories.presence);
  assert.equal(p.categories.connect, false, "an explicit false must survive");
});

test("normalize migrates a v1 entry: chat categories drop, the rest carries", () => {
  const v1 = {
    master: false,
    volume: 0.9,
    dnd: true,
    categories: { mention: false, dm: true, message: false, presence: true, error: false },
  };
  const p = normalizeSoundPrefs(v1);
  assert.equal(p.master, false);
  assert.equal(p.volume, 0.9);
  assert.equal(p.dnd, true);
  assert.equal(p.categories.presence, true);
  assert.equal(p.categories.error, false);
  assert.deepEqual(
    Object.keys(p.categories).sort(),
    [...MACHINE_CATEGORIES].sort(),
    "no chat category may survive into v2 prefs",
  );
});

test("every category round-trips both ways", () => {
  for (const c of MACHINE_CATEGORIES) {
    for (const on of [true, false]) {
      const p = normalizeSoundPrefs({ categories: { [c]: on } });
      assert.equal(p.categories[c as MachineCategory], on);
    }
  }
});

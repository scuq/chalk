// Notification sound prefs: the parsing rules.
//
// This entry is in localStorage, which means it is user-editable, it
// survives upgrades, and it can be left half-written by a crashed tab.
// normalize has to be total over all of that -- the failure mode we care
// about is a stored value that either throws on load (no app) or that
// turns every category on at full volume (a noise complaint).

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSoundPrefs } from "./prefs.ts";
import {
  DEFAULT_SOUND_PREFS,
  MAX_VOLUME,
  MIN_VOLUME,
  SOUND_CATEGORIES,
  type SoundCategory,
} from "./types.ts";

test("normalize keeps a valid pref untouched", () => {
  const prefs = {
    master: true,
    volume: 0.7,
    dnd: true,
    categories: { ...DEFAULT_SOUND_PREFS.categories, message: true },
  };
  assert.deepEqual(normalizeSoundPrefs(prefs), prefs);
});

test("normalize falls back on junk input", () => {
  for (const junk of [null, undefined, 42, "loud", [], true]) {
    assert.deepEqual(normalizeSoundPrefs(junk), DEFAULT_SOUND_PREFS);
  }
});

test("normalize defaults to silence", () => {
  const p = normalizeSoundPrefs({});
  assert.equal(p.master, false, "master must default off -- an update must not start making noise");
  assert.equal(p.dnd, false);
  assert.equal(p.categories.message, false, "'every message' must default off even under master");
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
    for (const c of SOUND_CATEGORIES) {
      assert.equal(typeof p.categories[c], "boolean", `${c} must be present`);
    }
  }
});

test("normalize takes only booleans for a category", () => {
  const p = normalizeSoundPrefs({ categories: { message: "yes", mention: false } });
  assert.equal(p.categories.message, DEFAULT_SOUND_PREFS.categories.message);
  assert.equal(p.categories.mention, false, "an explicit false must survive");
});

test("normalize drops categories this build cannot play", () => {
  const p = normalizeSoundPrefs({ categories: { mention: true, klaxon: true } });
  assert.deepEqual(Object.keys(p.categories).sort(), [...SOUND_CATEGORIES].sort());
});

test("every category round-trips both ways", () => {
  for (const c of SOUND_CATEGORIES) {
    for (const on of [true, false]) {
      const p = normalizeSoundPrefs({ categories: { [c]: on } });
      assert.equal(p.categories[c as SoundCategory], on);
    }
  }
});

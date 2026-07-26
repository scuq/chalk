// The away-detection pref. Only the pure half is tested; the localStorage
// wrappers are not, which is the convention net-prefs and mic-prefs set.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_IDLE_PREFS, normalizeIdlePrefs } from "./idle-prefs.ts";

test("system idle detection is on out of the box", () => {
  // Pinned deliberately: this is an opt-out, and flipping it to opt-in is a
  // decision someone should have to come here and change on purpose.
  assert.equal(DEFAULT_IDLE_PREFS.systemIdle, true);
});

test("a missing or corrupt stored value falls back to the defaults", () => {
  for (const raw of [null, undefined, "", "nonsense", 7, [], {}]) {
    assert.deepEqual(normalizeIdlePrefs(raw), DEFAULT_IDLE_PREFS);
  }
});

test("a stored off survives the round trip", () => {
  // The failure that matters: an opt-out silently reverting to on, which
  // would re-prompt someone who already said no.
  assert.deepEqual(normalizeIdlePrefs({ systemIdle: false }), { systemIdle: false });
});

test("a non-boolean field is replaced, not coerced", () => {
  // "false" and 0 are both truthy-adjacent traps; neither should be read as
  // an opt-out, and neither should be kept as-is.
  assert.deepEqual(normalizeIdlePrefs({ systemIdle: "false" }), DEFAULT_IDLE_PREFS);
  assert.deepEqual(normalizeIdlePrefs({ systemIdle: 0 }), DEFAULT_IDLE_PREFS);
});

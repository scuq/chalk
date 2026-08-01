// 66-1: the account-wide join default. The per-device half (localStorage) is
// untested by the same convention mic-prefs sets -- only the pure resolver is
// here, and its whole job is which way an absent or junk value falls.

import { test } from "node:test";
import assert from "node:assert/strict";

import { selectJoinMuted } from "../state/types";

test("selectJoinMuted defaults to muted when nothing is stored", () => {
  assert.equal(selectJoinMuted(undefined), true);
  assert.equal(selectJoinMuted({}), true);
  assert.equal(selectJoinMuted({ voice: {} }), true);
});

test("selectJoinMuted honours an explicit setting", () => {
  assert.equal(selectJoinMuted({ voice: { joinMuted: false } }), false);
  assert.equal(selectJoinMuted({ voice: { joinMuted: true } }), true);
});

test("selectJoinMuted falls to muted on a junk value", () => {
  // Only an explicit false opts into a hot mic; anything else is muted.
  assert.equal(selectJoinMuted({ voice: { joinMuted: "no" } } as never), true);
  assert.equal(selectJoinMuted({ voice: { joinMuted: null } } as never), true);
});

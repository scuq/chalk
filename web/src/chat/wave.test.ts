// 115-3: how a name is cut for the wave.

import { test } from "node:test";
import assert from "node:assert/strict";

import { WAVE_MAX_LETTERS, WAVE_MS, splitLetters } from "./wave";

test("a plain handle is one entry per letter", () => {
  assert.deepEqual(splitLetters("alice"), ["a", "l", "i", "c", "e"]);
});

test("code points, not UTF-16 units: an emoji or an accent moves whole", () => {
  assert.deepEqual(splitLetters("bob🔥"), ["b", "o", "b", "🔥"]);
  assert.deepEqual(splitLetters("zoë"), ["z", "o", "ë"]);
});

test("a space survives as a no-break space so it keeps its width", () => {
  assert.deepEqual(splitLetters("a b"), ["a", " ", "b"]);
});

test("an empty name is an empty wave", () => {
  assert.deepEqual(splitLetters(""), []);
});

// Pinned because theme.css carries exactly this many delay rules and the
// two files have no other way to agree.
test("the letter cap and the wave length are what the stylesheet was written for", () => {
  assert.equal(WAVE_MAX_LETTERS, 16);
  assert.equal(WAVE_MS, 2400);
});

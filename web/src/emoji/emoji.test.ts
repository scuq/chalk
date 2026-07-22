import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ALL_EMOJI,
  EMOJI_CATEGORIES,
  searchEmoji,
  insertAtCursor,
} from "./emoji.ts";

test("catalogue is non-trivial and every entry is well-formed", () => {
  assert.ok(ALL_EMOJI.length > 200, `only ${ALL_EMOJI.length} emoji`);
  for (const e of ALL_EMOJI) {
    assert.ok(e.c.length > 0, "char present");
    assert.ok(e.n.length > 0, `name present for ${e.c}`);
    assert.ok(Array.isArray(e.k), `keywords array for ${e.n}`);
    assert.equal(e.n, e.n.toLowerCase(), `name lowercased: ${e.n}`);
  }
});

test("category ids are unique and every category has entries", () => {
  const ids = EMOJI_CATEGORIES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "unique category ids");
  for (const c of EMOJI_CATEGORIES) {
    assert.ok(c.emoji.length > 0, `${c.id} is non-empty`);
  }
});

test("searchEmoji returns nothing for an empty query", () => {
  assert.deepEqual(searchEmoji(""), []);
  assert.deepEqual(searchEmoji("   "), []);
});

test("searchEmoji finds by keyword, not just official name", () => {
  // "face with tears of joy" is the Unicode name; nobody types that.
  const lol = searchEmoji("lol");
  assert.ok(lol.some((e) => e.c === "😂"), "lol finds joy");

  const plus1 = searchEmoji("+1");
  assert.ok(plus1.some((e) => e.c === "👍"), "+1 finds thumbs up");
});

test("searchEmoji ranks the on-the-nose match first", () => {
  const cat = searchEmoji("cat");
  assert.equal(cat[0].c, "🐱", "the cat outranks incidental 'cat' matches");

  const fire = searchEmoji("fire");
  assert.equal(fire[0].n, "fire");
});

test("searchEmoji is case-insensitive and respects the limit", () => {
  assert.deepEqual(
    searchEmoji("PIZZA").map((e) => e.c),
    searchEmoji("pizza").map((e) => e.c),
  );
  assert.ok(searchEmoji("a", 5).length <= 5);
});

test("insertAtCursor splices at the caret and reports the new caret", () => {
  const r = insertAtCursor("hello world", "🙂", 5, 5);
  assert.equal(r.value, "hello🙂 world");
  assert.equal(r.caret, 5 + "🙂".length);
});

test("insertAtCursor replaces a selection", () => {
  const r = insertAtCursor("hello world", "👍", 0, 5);
  assert.equal(r.value, "👍 world");
  assert.equal(r.caret, "👍".length);
});

test("insertAtCursor appends when the caret is at the end", () => {
  const r = insertAtCursor("hi", "🎉", 2, 2);
  assert.equal(r.value, "hi🎉");
  assert.equal(r.caret, 2 + "🎉".length);
});

test("insertAtCursor clamps an out-of-range or reversed selection", () => {
  // Stale selection past the end must not throw or drop the draft.
  const past = insertAtCursor("abc", "!", 99, 99);
  assert.equal(past.value, "abc!");

  const reversed = insertAtCursor("abc", "!", 2, 1);
  assert.equal(reversed.value, "ab!c", "end clamps up to start");

  const negative = insertAtCursor("abc", "!", -5, -5);
  assert.equal(negative.value, "!abc");
});

test("insertAtCursor leaves an empty draft holding just the emoji", () => {
  const r = insertAtCursor("", "🚀", 0, 0);
  assert.equal(r.value, "🚀");
  assert.equal(r.caret, "🚀".length);
});

// Tests for the phone list filter: the kinds, the text match on the match
// text, and the rule that the kind and the text must both match.

import { test } from "node:test";
import assert from "node:assert/strict";

import { ZUCKER_KINDS, filterZuckerRows, matchesKind, zuckerFilterActive } from "./zucker-filter";

const row = (over: Partial<Parameters<typeof matchesKind>[0]> = {}) => ({
  name: "general",
  isDM: false,
  isVoice: false,
  unread: false,
  mention: false,
  ...over,
});

const rows = [
  row({ name: "general" }),
  row({ name: "gen", matchText: "[Gaming] General gen", unread: true }),
  row({ name: "@bob", isDM: true, unread: true, mention: true }),
  row({ name: "lounge", isVoice: true }),
];

test("no kind and no text returns the same array, so a caller can tell nothing is filtered", () => {
  assert.equal(filterZuckerRows(rows, "all", ""), rows);
  assert.equal(filterZuckerRows(rows, "all", "   "), rows);
  assert.equal(zuckerFilterActive("all", " "), false);
  assert.equal(zuckerFilterActive("unread", ""), true);
  assert.equal(zuckerFilterActive("all", "g"), true);
});

test("each kind keeps its own rows", () => {
  const names = (kind: Parameters<typeof matchesKind>[1]) => filterZuckerRows(rows, kind, "").map((r) => r.name);
  assert.deepEqual(names("unread"), ["gen", "@bob"]);
  assert.deepEqual(names("mentions"), ["@bob"]);
  assert.deepEqual(names("channels"), ["general", "gen"]);
  assert.deepEqual(names("dms"), ["@bob"]);
  assert.deepEqual(names("voice"), ["lounge"]);
});

test("a mention counts only while the row is unread", () => {
  assert.equal(matchesKind(row({ mention: true, unread: false }), "mentions"), false);
});

test("the text matches the match text when a row has one, so both channel names hit", () => {
  // The row shows the short name "gen"; its full name is only in matchText.
  assert.deepEqual(filterZuckerRows(rows, "all", "gaming").map((r) => r.name), ["gen"]);
  assert.deepEqual(filterZuckerRows(rows, "all", "GEN").map((r) => r.name), ["general", "gen"]);
  assert.deepEqual(filterZuckerRows(rows, "all", " bob ").map((r) => r.name), ["@bob"]);
});

test("the kind and the text must both match", () => {
  assert.deepEqual(filterZuckerRows(rows, "unread", "gen").map((r) => r.name), ["gen"]);
  assert.deepEqual(filterZuckerRows(rows, "voice", "gen"), []);
});

test("the chip list starts with all and has no kind twice", () => {
  assert.equal(ZUCKER_KINDS[0].kind, "all");
  assert.equal(new Set(ZUCKER_KINDS.map((k) => k.kind)).size, ZUCKER_KINDS.length);
});

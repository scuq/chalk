import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TYPING_MAX_NAMES,
  TYPING_PING_MS,
  TYPING_TTL_MS,
  formatTypingLine,
  liveTypists,
  typingSegments,
} from "./typing";
import { selectChatPrefs } from "../state/types";

const CROWD = "many keyboards are on fire 🔥";

function names(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `user${i + 1}`);
}

test("nobody typing renders nothing at all", () => {
  assert.equal(formatTypingLine([]), null);
});

test("one typist", () => {
  assert.equal(formatTypingLine(["alice"]), "alice is typing...");
});

test("two typists are joined with 'and', no comma", () => {
  assert.equal(formatTypingLine(["alice", "bob"]), "alice and bob are typing...");
});

test("three to five are a comma list with 'and' before the last", () => {
  assert.equal(
    formatTypingLine(["alice", "bob", "carol"]),
    "alice, bob and carol are typing...",
  );
  assert.equal(
    formatTypingLine(["alice", "bob", "carol", "dave", "eve"]),
    "alice, bob, carol, dave and eve are typing...",
  );
});

// The threshold is the whole product decision, so pin both sides of it.
test("five names still list; six collapse to the crowd line", () => {
  assert.notEqual(formatTypingLine(names(TYPING_MAX_NAMES)), CROWD);
  assert.equal(formatTypingLine(names(TYPING_MAX_NAMES + 1)), CROWD);
  assert.equal(formatTypingLine(names(40)), CROWD);
});

// The crowd line must never grow a count: the viewer is excluded from the
// list, so any number printed would be wrong by one for them.
test("the crowd line carries no number", () => {
  assert.equal(/\d/.test(formatTypingLine(names(9)) ?? ""), false);
});

// The UI tints handles and leaves the punctuation alone, so the split has to
// mark exactly the name pieces and nothing else.
test("segments mark every handle and only the handles", () => {
  const segs = typingSegments(["alice", "bob"]);
  assert.deepEqual(
    segs.map((s) => s.handle),
    ["alice", null, "bob", null],
  );
  assert.deepEqual(
    segs.map((s) => s.text),
    ["alice", " and ", "bob", " are typing..."],
  );
});

test("the crowd line has no tintable name in it", () => {
  const segs = typingSegments(names(TYPING_MAX_NAMES + 1));
  assert.equal(segs.length, 1);
  assert.equal(segs[0].handle, null);
});

test("segments and the formatted line never disagree", () => {
  for (const n of [0, 1, 2, 3, 5, 6, 20]) {
    const joined = typingSegments(names(n))
      .map((s) => s.text)
      .join("");
    assert.equal(joined, formatTypingLine(names(n)) ?? "");
  }
});

test("liveTypists keeps unexpired entries in insertion order", () => {
  const entries = new Map([
    ["alice", 2000],
    ["bob", 3000],
  ]);
  assert.deepEqual(liveTypists(entries, 1000), ["alice", "bob"]);
});

test("liveTypists drops an entry at its deadline, not after", () => {
  const entries = new Map([["alice", 2000]]);
  assert.deepEqual(liveTypists(entries, 1999), ["alice"]);
  assert.deepEqual(liveTypists(entries, 2000), []);
  assert.deepEqual(liveTypists(entries, 2001), []);
});

test("liveTypists on an empty map is empty", () => {
  assert.deepEqual(liveTypists(new Map(), 1000), []);
});

// A name must survive at least two dropped pings, or it flickers under
// someone who never stopped typing.
test("the TTL leaves room for two missed pings", () => {
  assert.ok(TYPING_TTL_MS > 2 * TYPING_PING_MS);
});

test("typing indicators are on unless turned off", () => {
  assert.equal(selectChatPrefs(undefined).typingIndicators, true);
  assert.equal(selectChatPrefs({}).typingIndicators, true);
  assert.equal(selectChatPrefs({ chat: {} }).typingIndicators, true);
  assert.equal(selectChatPrefs({ chat: { typingIndicators: false } }).typingIndicators, false);
});

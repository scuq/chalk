import { test } from "node:test";
import assert from "node:assert/strict";

import {
  activeMentionToken,
  matchMentionHandles,
  applyMention,
} from "./mention-complete";

test("activeMentionToken finds a bare @ at start of text", () => {
  assert.deepEqual(activeMentionToken("@", 1), { start: 0, prefix: "" });
});

test("activeMentionToken finds a partial handle", () => {
  assert.deepEqual(activeMentionToken("hey @ali", 8), { start: 4, prefix: "ali" });
});

test("activeMentionToken allows digits and underscores in the prefix", () => {
  assert.deepEqual(activeMentionToken("@carol_2", 8), { start: 0, prefix: "carol_2" });
});

test("activeMentionToken returns null with no @ in reach", () => {
  assert.equal(activeMentionToken("hello", 5), null);
});

test("activeMentionToken returns null when a space breaks the token", () => {
  assert.equal(activeMentionToken("@ali ce", 7), null);
});

test("activeMentionToken returns null for an email-style token", () => {
  assert.equal(activeMentionToken("mail bob@ali", 12), null);
});

test("activeMentionToken returns null for a doubled @@", () => {
  assert.equal(activeMentionToken("@@ali", 5), null);
});

test("activeMentionToken accepts @ after punctuation", () => {
  assert.deepEqual(activeMentionToken("(@ali", 5), { start: 1, prefix: "ali" });
});

test("activeMentionToken returns null when the caret is mid-token", () => {
  assert.equal(activeMentionToken("@alice", 3), null);
});

test("activeMentionToken allows a caret before punctuation", () => {
  assert.deepEqual(activeMentionToken("@ali!", 4), { start: 0, prefix: "ali" });
});

test("activeMentionToken returns null at position zero", () => {
  assert.equal(activeMentionToken("@alice", 0), null);
});

test("activeMentionToken returns null past any legal handle length", () => {
  const long = "@" + "a".repeat(33);
  assert.equal(activeMentionToken(long, long.length), null);
});

test("matchMentionHandles returns everything for an empty prefix", () => {
  assert.deepEqual(matchMentionHandles("", ["carol", "alice", "bob"]), [
    "alice",
    "bob",
    "carol",
  ]);
});

test("matchMentionHandles ranks prefix matches before substring matches", () => {
  assert.deepEqual(matchMentionHandles("al", ["salad", "alice", "gal", "albert"]), [
    "albert",
    "alice",
    "gal",
    "salad",
  ]);
});

test("matchMentionHandles folds case both ways", () => {
  assert.deepEqual(matchMentionHandles("AL", ["Alice"]), ["alice"]);
});

test("matchMentionHandles drops non-matches and dedupes", () => {
  assert.deepEqual(matchMentionHandles("ali", ["alice", "Alice", "bob"]), ["alice"]);
});

test("applyMention replaces the token and appends a space", () => {
  const r = applyMention("hey @ali", { start: 4, prefix: "ali" }, 8, "alice");
  assert.equal(r.value, "hey @alice ");
  assert.equal(r.caret, 11);
});

test("applyMention preserves text after the caret", () => {
  const r = applyMention("@al, hi", { start: 0, prefix: "al" }, 3, "alice");
  assert.equal(r.value, "@alice , hi");
  assert.equal(r.caret, 7);
});

test("applyMention completes a bare @", () => {
  const r = applyMention("@", { start: 0, prefix: "" }, 1, "bob");
  assert.equal(r.value, "@bob ");
  assert.equal(r.caret, 5);
});

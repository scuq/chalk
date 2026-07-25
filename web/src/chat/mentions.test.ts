import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mentionedHandles,
  mentionsHandle,
  splitBodyMentions,
} from "./mentions";

const known = new Set(["alice", "bob", "carol_x"]);

test("mentionedHandles finds a plain mention", () => {
  assert.deepEqual(mentionedHandles("hey @alice look at this"), ["alice"]);
});

test("mentionedHandles folds case", () => {
  assert.deepEqual(mentionedHandles("@Alice and @BOB"), ["alice", "bob"]);
});

test("mentionedHandles dedupes", () => {
  assert.deepEqual(mentionedHandles("@alice @alice @alice"), ["alice"]);
});

test("mentionedHandles matches at start of body", () => {
  assert.deepEqual(mentionedHandles("@alice hi"), ["alice"]);
});

test("mentionedHandles handles surrounding punctuation", () => {
  assert.deepEqual(mentionedHandles("(@alice), @bob: hi"), ["alice", "bob"]);
});

test("mentionedHandles ignores an email address", () => {
  assert.deepEqual(mentionedHandles("mail me at bob@alice.com"), []);
});

test("mentionedHandles ignores a token glued to a word", () => {
  assert.deepEqual(mentionedHandles("foo@alice"), []);
});

test("mentionedHandles rejects handles that are too short", () => {
  assert.deepEqual(mentionedHandles("@ab is not a handle"), []);
});

test("mentionedHandles rejects handles that are too long", () => {
  const long = "a".repeat(33);
  assert.deepEqual(mentionedHandles("@" + long), []);
});

test("mentionedHandles accepts underscores and digits", () => {
  assert.deepEqual(mentionedHandles("@carol_x and @user2000"), [
    "carol_x",
    "user2000",
  ]);
});

test("mentionedHandles ignores a bare @", () => {
  assert.deepEqual(mentionedHandles("what @ even"), []);
});

test("mentionsHandle is case-insensitive both ways", () => {
  assert.equal(mentionsHandle("ping @Alice", "alice"), true);
  assert.equal(mentionsHandle("ping @alice", "ALICE"), true);
});

test("mentionsHandle does not match a prefix of a longer handle", () => {
  assert.equal(mentionsHandle("ping @alicexyz", "alice"), false);
});

test("mentionsHandle is false for an empty handle", () => {
  assert.equal(mentionsHandle("ping @alice", ""), false);
});

test("splitBodyMentions returns one segment when there is nothing to mark", () => {
  const segs = splitBodyMentions("just a message", known);
  assert.deepEqual(segs, [{ text: "just a message" }]);
});

test("splitBodyMentions marks a known handle and keeps the surrounding text", () => {
  const segs = splitBodyMentions("hey @alice look", known);
  assert.deepEqual(segs, [
    { text: "hey " },
    { text: "@alice", handle: "alice" },
    { text: " look" },
  ]);
});

test("splitBodyMentions leaves an unknown handle as plain text", () => {
  const segs = splitBodyMentions("hey @nobody look", known);
  assert.deepEqual(segs, [{ text: "hey @nobody look" }]);
});

test("splitBodyMentions handles a mention at the very start and end", () => {
  const segs = splitBodyMentions("@alice ping @bob", known);
  assert.deepEqual(segs, [
    { text: "@alice", handle: "alice" },
    { text: " ping " },
    { text: "@bob", handle: "bob" },
  ]);
});

test("splitBodyMentions preserves the original casing of the token", () => {
  const segs = splitBodyMentions("hi @Alice", known);
  assert.deepEqual(segs, [
    { text: "hi " },
    { text: "@Alice", handle: "alice" },
  ]);
});

test("splitBodyMentions rejoins to the original body", () => {
  const body = "(@alice), tell @carol_x that @nobody left. bob@alice.com";
  const segs = splitBodyMentions(body, known);
  assert.equal(segs.map((s) => s.text).join(""), body);
});

test("splitBodyMentions marks only known handles in a mixed body", () => {
  const body = "@alice @nobody @bob";
  const marked = splitBodyMentions(body, known)
    .filter((s) => s.handle)
    .map((s) => s.handle);
  assert.deepEqual(marked, ["alice", "bob"]);
});

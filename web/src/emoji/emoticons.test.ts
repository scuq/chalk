import { test } from "node:test";
import assert from "node:assert/strict";
import { EMOTICONS, replaceEmoticonBefore } from "./emoticons";

test("replaces an emoticon typed at the start of the draft", () => {
  const r = replaceEmoticonBefore(":)", 2);
  assert.ok(r);
  assert.equal(r.value, "😀");
  assert.equal(r.caret, r.value.length);
  assert.equal(r.text, ":)");
});

test("replaces an emoticon after whitespace", () => {
  const r = replaceEmoticonBefore("hello :)", 8);
  assert.ok(r);
  assert.equal(r.value, "hello 😀");
  assert.equal(r.caret, "hello ".length + "😀".length);
});

test("replaces mid-draft and keeps the trailing text", () => {
  const r = replaceEmoticonBefore("a :) b", 4);
  assert.ok(r);
  assert.equal(r.value, "a 😀 b");
  assert.equal(r.caret, "a 😀".length);
});

test("a newline counts as a boundary", () => {
  const r = replaceEmoticonBefore("line\n:)", 7);
  assert.ok(r);
  assert.equal(r.value, "line\n😀");
});

test("does not fire mid-word", () => {
  assert.equal(replaceEmoticonBefore("http:/", 6), null);
  assert.equal(replaceEmoticonBefore("path:\\", 6), null);
  assert.equal(replaceEmoticonBefore("ratio 3:)", 9), null);
});

test("does not fire on a second emoticon typed onto the first", () => {
  assert.equal(replaceEmoticonBefore(":):)", 4), null);
});

test("longest token wins", () => {
  const angry = replaceEmoticonBefore(">:(", 3);
  assert.ok(angry);
  assert.equal(angry.value, "😠");

  const crying = replaceEmoticonBefore(":'(", 3);
  assert.ok(crying);
  assert.equal(crying.value, "😢");

  const winkTongue = replaceEmoticonBefore(";P", 2);
  assert.ok(winkTongue);
  assert.equal(winkTongue.value, "😜");
});

test("case is significant", () => {
  const upper = replaceEmoticonBefore(":D", 2);
  const lower = replaceEmoticonBefore(":d", 2);
  assert.ok(upper);
  assert.equal(lower, null);
});

test("no bare 8) so numbered lists survive", () => {
  assert.equal(replaceEmoticonBefore("see step 8)", 11), null);
  const hyphenated = replaceEmoticonBefore("8-)", 3);
  assert.ok(hyphenated);
  assert.equal(hyphenated.value, "😎");
});

test("returns null when there is no emoticon", () => {
  assert.equal(replaceEmoticonBefore("just text", 9), null);
  assert.equal(replaceEmoticonBefore("", 0), null);
  assert.equal(replaceEmoticonBefore(":)", 0), null);
});

test("ignores a caret past the end of the value", () => {
  assert.equal(replaceEmoticonBefore(":)", 5), null);
});

test("every token maps to a non-empty emoji and is unique", () => {
  const seen = new Set<string>();
  for (const { text, emoji } of EMOTICONS) {
    assert.ok(text.length >= 2, `token too short: ${text}`);
    assert.ok(emoji.length > 0, `no emoji for ${text}`);
    assert.ok(!seen.has(text), `duplicate token: ${text}`);
    seen.add(text);
  }
});

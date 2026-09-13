import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TYPING_MAX_NAMES,
  TYPING_PING_MS,
  TYPING_TTL_MS,
  TYPING_WAVE_WORD,
  formatTypingLine,
  liveTypists,
  typingSegments,
} from "./typing";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { splitLetters } from "./wave";
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
    ["alice", null, "bob", null, null],
  );
  assert.deepEqual(
    segs.map((s) => s.text),
    ["alice", " and ", "bob", " are ", "typing..."],
  );
});

// Only the trailing word segment carries the wave, so a wave preference
// never touches a name or the joining words around it.
test("only the word typing is marked to wave", () => {
  for (const n of [1, 2, 5]) {
    const waving = typingSegments(names(n)).filter((s) => s.wave);
    assert.deepEqual(waving.map((s) => s.text), [TYPING_WAVE_WORD]);
    assert.equal(waving[0].handle, null);
  }
  assert.equal(typingSegments(names(TYPING_MAX_NAMES + 1)).some((s) => s.wave), false);
});

// The delay-per-letter contract lives in the stylesheet, not in a pure
// function, so this test reads theme.css directly.
test("the typing wave carries one delay per letter, in order", () => {
  const css = readFileSync(join(resolve(process.cwd(), "src"), "theme.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const delays = [...css.matchAll(/\.chalk-typing-wave-ch:nth-child\((\d+)\)\s*\{\s*animation-delay:\s*(\d+)ms/g)]
    .map((m) => [Number(m[1]), Number(m[2])] as const);
  assert.equal(delays.length, splitLetters(TYPING_WAVE_WORD).length);
  for (let i = 0; i < delays.length; i++) {
    assert.equal(delays[i][0], i + 1);
    if (i > 0) assert.ok(delays[i][1] > delays[i - 1][1]);
  }
  const reduced = /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.chalk-typing-wave-ch\s*\{\s*animation:\s*none;/;
  assert.ok(reduced.test(css), "reduced motion does not stop the typing wave");
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

test("the typing wave is on unless turned off", () => {
  assert.equal(selectChatPrefs(undefined).typingWave, true);
  assert.equal(selectChatPrefs({ chat: {} }).typingWave, true);
  assert.equal(selectChatPrefs({ chat: { typingWave: false } }).typingWave, false);
});

// 116-2: the what's-new note's model -- what is unread, and what the read
// mark means.

import { test } from "node:test";
import assert from "node:assert/strict";

import { WHATS_NEW, latestWhatsNew, parseWhatsNewRead, unreadWhatsNew } from "./whats-new";

const ENTRIES = [
  { phase: 113, title: "a", lines: ["x"] },
  { phase: 115, title: "c", lines: ["x"] },
  { phase: 114, title: "b", lines: ["x"] },
];

test("nothing read means every note is unread, newest first", () => {
  assert.deepEqual(unreadWhatsNew(0, ENTRIES).map((e) => e.phase), [115, 114, 113]);
});

test("a read mark hides that phase and everything before it", () => {
  assert.deepEqual(unreadWhatsNew(114, ENTRIES).map((e) => e.phase), [115]);
  assert.deepEqual(unreadWhatsNew(115, ENTRIES), []);
  assert.deepEqual(unreadWhatsNew(999, ENTRIES), []);
});

test("latest is the highest phase, and 0 for no notes", () => {
  assert.equal(latestWhatsNew(ENTRIES), 115);
  assert.equal(latestWhatsNew([]), 0);
});

// The mark comes out of an opaque JSON blob: anything odd reads as unread
// rather than as "read everything", so a corrupt pref shows the note rather
// than hiding it forever.
test("the read mark is parsed defensively", () => {
  assert.equal(parseWhatsNewRead(115), 115);
  assert.equal(parseWhatsNewRead("115"), 115);
  assert.equal(parseWhatsNewRead(115.9), 115);
  for (const junk of [undefined, null, "", "lots", -3, NaN, {}, [], true]) {
    assert.equal(parseWhatsNewRead(junk), 0, `junk ${String(junk)}`);
  }
});

// The shipped list: every entry says something, and the phases are unique so
// the read mark means one thing.
test("the shipped notes are well formed", () => {
  assert.ok(WHATS_NEW.length >= 1);
  const phases = new Set<number>();
  for (const e of WHATS_NEW) {
    assert.ok(Number.isInteger(e.phase) && e.phase > 0, `phase ${e.phase}`);
    assert.ok(!phases.has(e.phase), `duplicate phase ${e.phase}`);
    phases.add(e.phase);
    assert.ok(e.title.trim().length > 0, "empty title");
    assert.ok(e.lines.length > 0 && e.lines.every((l) => l.trim().length > 0), "empty line");
  }
});

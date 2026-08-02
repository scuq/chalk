import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SETTINGS_TABS,
  SETTINGS_SECTIONS,
  SECTION_TAB,
  matchSections,
} from "./settings-nav";

test("empty or whitespace query means not filtering", () => {
  assert.equal(matchSections(""), null);
  assert.equal(matchSections("   "), null);
});

test("matches are case-insensitive substrings of title and keywords", () => {
  assert.deepEqual(matchSections("VOLUME"), new Set(["notifications"]));
  assert.deepEqual(matchSections("passke"), new Set(["passkeys"]));
  assert.ok(matchSections("theme")!.has("appearance"));
});

test("the keyboard cheat sheet is findable by what it is called", () => {
  for (const q of ["keyboard", "shortcuts", "hotkeys"]) {
    assert.ok(matchSections(q)!.has("shortcuts"), `"${q}" missed the section`);
  }
  assert.equal(SECTION_TAB["shortcuts"], "chat");
});

test("a term can hit several sections", () => {
  const hits = matchSections("email")!;
  assert.ok(hits.has("identity"));
  assert.ok(hits.has("email"));
});

test("multi-term queries AND together", () => {
  assert.deepEqual(matchSections("sound volume"), new Set(["notifications"]));
  assert.deepEqual(matchSections("sound theme"), new Set());
});

test("no match yields an empty set, not null", () => {
  const hits = matchSections("xyzzy");
  assert.ok(hits instanceof Set);
  assert.equal(hits.size, 0);
});

test("registry: 17 unique sections, valid tabs, keywords present", () => {
  assert.equal(SETTINGS_SECTIONS.length, 17);
  const ids = new Set(SETTINGS_SECTIONS.map((s) => s.id));
  assert.equal(ids.size, SETTINGS_SECTIONS.length);
  const tabs = new Set(SETTINGS_TABS.map((t) => t.id));
  for (const s of SETTINGS_SECTIONS) {
    assert.ok(tabs.has(s.tab), `section ${s.id} has unknown tab ${s.tab}`);
    assert.ok(s.keywords.length >= 1, `section ${s.id} has no keywords`);
    assert.equal(SECTION_TAB[s.id], s.tab);
  }
});

test("registry: every tab owns at least one section", () => {
  for (const t of SETTINGS_TABS) {
    assert.ok(
      SETTINGS_SECTIONS.some((s) => s.tab === t.id),
      `tab ${t.id} owns no sections`
    );
  }
});

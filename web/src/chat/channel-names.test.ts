// 106-3: the short/full label rules the sidebar and Zuckermode share.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_SHORT_NAME_LEN,
  filterText,
  labelIsAbbreviated,
  rosterLabel,
  shortNameLength,
} from "./channel-names";

const withShort = { name: "[Gaming] General", shortName: "gaming" };
const noShort = { name: "[Gaming] General", shortName: "" };

test("full style always shows the full name", () => {
  assert.equal(rosterLabel(withShort, "full"), "[Gaming] General");
  assert.equal(rosterLabel(noShort, "full"), "[Gaming] General");
});

test("short style shows the short name, and falls back when none is set", () => {
  assert.equal(rosterLabel(withShort, "short"), "gaming");
  assert.equal(rosterLabel(noShort, "short"), "[Gaming] General");
  // A whitespace-only short name is "none", not a blank row.
  assert.equal(rosterLabel({ name: "x", shortName: "   " }, "short"), "x");
});

test("labelIsAbbreviated is true only when the row shows the short name", () => {
  assert.equal(labelIsAbbreviated(withShort, "short"), true);
  assert.equal(labelIsAbbreviated(withShort, "full"), false);
  assert.equal(labelIsAbbreviated(noShort, "short"), false);
});

test("shortNameLength counts characters, not UTF-16 units", () => {
  assert.equal(shortNameLength("0123456789"), 10);
  assert.equal(shortNameLength("🎮🎮🎮🎮🎮🎮🎮🎮🎮🎮"), 10);
  assert.equal(shortNameLength("  trim  "), 4);
  assert.equal(MAX_SHORT_NAME_LEN, 10);
});

test("the filter text carries both names so either matches", () => {
  assert.equal(filterText(withShort), "[Gaming] General gaming");
  assert.equal(filterText(noShort), "[Gaming] General");
  assert.ok(filterText(withShort).toLowerCase().includes("gaming"));
});

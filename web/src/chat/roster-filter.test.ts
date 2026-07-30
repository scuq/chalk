import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ROSTER_FILTER_THRESHOLD,
  filterRoster,
  showRosterFilter,
} from "./roster-filter";

const names = (items: { name: string }[]) => items.map((i) => i.name);

const list = [
  { name: "general" },
  { name: "Dev-Backend" },
  { name: "dev-frontend" },
  { name: "voice lounge" },
];

test("empty query returns the input array untouched", () => {
  assert.equal(filterRoster(list, "", (i) => i.name), list);
  assert.equal(filterRoster(list, "   ", (i) => i.name), list);
});

test("matches are case-insensitive substrings", () => {
  assert.deepEqual(names(filterRoster(list, "DEV", (i) => i.name)), [
    "Dev-Backend",
    "dev-frontend",
  ]);
  assert.deepEqual(names(filterRoster(list, "lounge", (i) => i.name)), [
    "voice lounge",
  ]);
});

test("query is trimmed before matching", () => {
  assert.deepEqual(names(filterRoster(list, "  gen ", (i) => i.name)), [
    "general",
  ]);
});

test("no match yields an empty list, not a throw", () => {
  assert.deepEqual(filterRoster(list, "zzz", (i) => i.name), []);
});

test("input order is preserved", () => {
  assert.deepEqual(names(filterRoster(list, "e", (i) => i.name)), [
    "general",
    "Dev-Backend",
    "dev-frontend",
    "voice lounge",
  ]);
});

test("showRosterFilter flips exactly at the threshold", () => {
  assert.equal(showRosterFilter(ROSTER_FILTER_THRESHOLD - 1), false);
  assert.equal(showRosterFilter(ROSTER_FILTER_THRESHOLD), true);
  assert.equal(showRosterFilter(ROSTER_FILTER_THRESHOLD + 1), true);
});

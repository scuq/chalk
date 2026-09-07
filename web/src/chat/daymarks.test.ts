import { test } from "node:test";
import assert from "node:assert/strict";
import { dayKey, dayLabel, dayMarkIndices, pinnedBottom } from "./daymarks";

// Every Date here is built from local components on purpose -- the module is
// about the reader's calendar day, so a UTC literal would be testing something
// else and would drift with the machine's timezone.
const at = (y: number, m: number, d: number, hh = 12, mm = 0) =>
  new Date(y, m - 1, d, hh, mm, 0, 0);

// A Thursday.
const NOW = at(2026, 9, 3, 14, 30);

test("dayKey is the local calendar day, not the UTC one", () => {
  assert.equal(dayKey(at(2026, 9, 3)), "2026-09-03");
  // Either side of local midnight: one hour apart, different days.
  assert.equal(dayKey(at(2026, 9, 3, 23, 59)), "2026-09-03");
  assert.equal(dayKey(at(2026, 9, 4, 0, 30)), "2026-09-04");
  // Zero-padded so the key sorts as a string.
  assert.equal(dayKey(at(2026, 1, 7)), "2026-01-07");
});

test("dayKey ignores the time of day", () => {
  assert.equal(dayKey(at(2026, 9, 3, 0, 0)), dayKey(at(2026, 9, 3, 23, 59)));
});

test("labels today and yesterday by name", () => {
  assert.equal(dayLabel(at(2026, 9, 3, 8, 15), NOW), "today");
  assert.equal(dayLabel(at(2026, 9, 3, 23, 59), NOW), "today");
  assert.equal(dayLabel(at(2026, 9, 2, 1, 0), NOW), "yesterday");
});

test("two to six days back is the weekday alone", () => {
  assert.equal(dayLabel(at(2026, 9, 1), NOW), "tuesday");
  assert.equal(dayLabel(at(2026, 8, 31), NOW), "monday");
  // Six days back is the last one that gets a bare weekday.
  assert.equal(dayLabel(at(2026, 8, 28), NOW), "friday");
});

test("a week or more back is a dated form, year only when it differs", () => {
  // Seven days back is the same weekday name as today, which alone would be
  // ambiguous -- so it takes the dated form.
  assert.equal(dayLabel(at(2026, 8, 27), NOW), "thu 27 aug");
  assert.equal(dayLabel(at(2026, 3, 9), NOW), "mon 9 mar");
  assert.equal(dayLabel(at(2025, 12, 24), NOW), "wed 24 dec 2025");
});

test("a future timestamp gets the full form, never today or a weekday", () => {
  assert.equal(dayLabel(at(2026, 9, 4), NOW), "fri 4 sep");
  assert.equal(dayLabel(at(2027, 1, 1), NOW), "fri 1 jan 2027");
});

test("no marks at all for an empty list", () => {
  assert.equal(dayMarkIndices([], NOW).size, 0);
});

test("a feed entirely from today gets no marks", () => {
  const stamps = [at(2026, 9, 3, 9), at(2026, 9, 3, 11), at(2026, 9, 3, 14)];
  assert.equal(dayMarkIndices(stamps, NOW).size, 0);
});

test("the leading row is marked when it is not today", () => {
  const stamps = [at(2026, 9, 2, 22), at(2026, 9, 2, 23)];
  const marks = dayMarkIndices(stamps, NOW);
  assert.deepEqual([...marks], [[0, "yesterday"]]);
});

test("every day boundary is marked, and the label is the day below it", () => {
  const stamps = [
    at(2026, 8, 30, 20), // sunday
    at(2026, 9, 1, 9), // tuesday -- a skipped day is still one boundary
    at(2026, 9, 1, 18),
    at(2026, 9, 3, 8), // today
    at(2026, 9, 3, 14),
  ];
  assert.deepEqual(
    [...dayMarkIndices(stamps, NOW)],
    [
      [0, "sunday"],
      [1, "tuesday"],
      [3, "today"],
    ],
  );
});

test("today's boundary is marked even though a leading today is not", () => {
  // The suppression is about the FIRST row only: crossing into today from
  // yesterday is a boundary the reader wants named.
  const stamps = [at(2026, 9, 2, 23), at(2026, 9, 3, 0, 10)];
  assert.deepEqual(
    [...dayMarkIndices(stamps, NOW)],
    [
      [0, "yesterday"],
      [1, "today"],
    ],
  );
});

test("an out-of-order timestamp marks the boundary in both directions", () => {
  const stamps = [at(2026, 9, 3, 9), at(2026, 9, 2, 9), at(2026, 9, 3, 10)];
  assert.deepEqual(
    [...dayMarkIndices(stamps, NOW)],
    [
      [1, "yesterday"],
      [2, "today"],
    ],
  );
});

test("pinnedBottom is the lowest stuck edge, and never negative", () => {
  // chalk's channel header pulls itself up with a negative top.
  assert.equal(pinnedBottom([{ top: -16, height: 64 }]), 48);
  // A second pinned band wins if it reaches further down.
  assert.equal(
    pinnedBottom([
      { top: -16, height: 64 },
      { top: -16, height: 180 },
    ]),
    164,
  );
  // Nothing pinned (thread panel, voice scratchpad).
  assert.equal(pinnedBottom([]), 0);
  // A box entirely above the scrollport contributes nothing.
  assert.equal(pinnedBottom([{ top: -80, height: 20 }]), 0);
});

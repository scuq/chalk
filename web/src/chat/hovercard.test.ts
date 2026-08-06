import { test } from "node:test";
import assert from "node:assert/strict";

import { lastSeenLine } from "./hovercard";

const now = new Date("2026-08-06T12:00:00Z");
const minutesAgo = (m: number) => now.getTime() - m * 60_000;

test("an online friend gets no line", () => {
  assert.equal(lastSeenLine("online", minutesAgo(90), now), null);
});

test("away and offline friends get the aged timestamp", () => {
  assert.equal(lastSeenLine("away", minutesAgo(12), now), "last seen 12m ago");
  assert.equal(lastSeenLine("offline", minutesAgo(180), now), "last seen 3h ago");
});

test("an unknown timestamp produces no line", () => {
  assert.equal(lastSeenLine("offline", undefined, now), null);
});

// A user with no device_presence rows aggregates to a zero time.Time, and
// at.UnixMilli() on that is ~-6.8e12 rather than 0. A truthiness check would
// have let it through and rendered a date in 1754.
test("a zero or negative timestamp produces no line", () => {
  assert.equal(lastSeenLine("offline", 0, now), null);
  assert.equal(lastSeenLine("offline", -6795364578871, now), null);
});

// Server and client clocks need not agree; a timestamp a few seconds in the
// future must still read as a time, not as a negative age.
test("a timestamp slightly in the future reads as just now", () => {
  assert.equal(
    lastSeenLine("away", now.getTime() + 3_000, now),
    "last seen just now",
  );
});

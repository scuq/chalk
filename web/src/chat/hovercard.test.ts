import { test } from "node:test";
import assert from "node:assert/strict";

import {
  displayNameLine,
  lastSeenLine,
  rosterCardInfo,
  senderCardInfo,
} from "./hovercard";

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

// ---- 92-5: the display-name line -------------------------------------------

test("a display name that adds something gets a line", () => {
  assert.equal(displayNameLine("dana", "Dana Okonkwo"), "Dana Okonkwo");
});

test("no display name, or one that only repeats the handle, gets no line", () => {
  assert.equal(displayNameLine("dana", undefined), null);
  assert.equal(displayNameLine("dana", ""), null);
  assert.equal(displayNameLine("dana", "   "), null);
  assert.equal(displayNameLine("dana", "dana"), null);
  // The directory stores what was typed; the handle is lowercased on the way
  // in. "Dana" over "dana" is the same word twice, not two facts.
  assert.equal(displayNameLine("dana", "Dana"), null);
  assert.equal(displayNameLine("dana", " dana "), null);
});

// ---- 92-1/92-5: the roster card --------------------------------------------

const roster = (over: Partial<Parameters<typeof rosterCardInfo>[0]> = {}) =>
  rosterCardInfo({
    userID: "11111111-2222-3333-4444-555555555555",
    handle: "dana",
    hue: 210,
    presence: "online",
    displayName: "Dana Okonkwo",
    lastSeenMS: undefined,
    showHint: false,
    now,
    ...over,
  });

test("a roster card names the friend, tints it, and adds the display name", () => {
  const info = roster();
  assert.equal(info.name, "dana");
  assert.equal(info.hue, 210);
  assert.equal(info.displayName, "Dana Okonkwo");
  assert.equal(info.state, "online");
  assert.equal(info.seen, null);
  assert.equal(info.hint, null);
  // The roster row knows no device, so the card has no identity footer.
  assert.equal(info.meta, null);
});

test("a roster card ages an offline friend and offers the chat hint", () => {
  const info = roster({
    presence: undefined,
    lastSeenMS: minutesAgo(45),
    showHint: true,
  });
  assert.equal(info.state, "offline");
  assert.equal(info.seen, "last seen 45m ago");
  assert.equal(info.hint, "start chat");
});

// A friend the server never gave a handle for falls back to a userID slice on
// the row, and the card has to say the same thing -- and must not pin a
// display name to a name that isn't one.
test("a handle-less friend falls back to the id slice with no display name", () => {
  const info = roster({ handle: "", displayName: "Dana Okonkwo" });
  assert.equal(info.name, "555555555555".slice(-8));
  assert.equal(info.displayName, null);
});

// ---- 92-6: the feed's sender card ------------------------------------------

const sender = (over: Partial<Parameters<typeof senderCardInfo>[0]> = {}) =>
  senderCardInfo({
    userID: "abcdef01-2222-3333-4444-555555555555",
    device: "9876543a-bbbb-cccc-dddd-eeeeeeeeeeee",
    handle: "dana",
    hue: 210,
    own: false,
    presence: "away",
    displayName: "Dana Okonkwo",
    lastSeenMS: minutesAgo(8),
    now,
    ...over,
  });

test("a sender card carries the name, the display name and the identity footer", () => {
  const info = sender();
  assert.equal(info.name, "dana");
  assert.equal(info.displayName, "Dana Okonkwo");
  assert.equal(info.state, "away");
  assert.equal(info.seen, "last seen 8m ago");
  assert.equal(info.hint, null);
  assert.equal(info.meta, "user abcdef01… · device 9876543a…");
});

// Presence subscriptions are friends-only server-side, so the map holds no
// entry for a channel member who isn't a friend. Rendering that as "offline"
// would be a guess printed as a fact.
test("a sender we hold no presence for gets no presence or last-seen line", () => {
  const info = sender({ presence: undefined });
  assert.equal(info.state, null);
  assert.equal(info.seen, null);
});

test("your own messages name you and skip presence", () => {
  const info = sender({ own: true });
  assert.equal(info.name, "dana (you)");
  assert.equal(info.state, null);
  assert.equal(info.seen, null);
  // Still worth the footer: which of your devices sent it.
  assert.equal(info.meta, "user abcdef01… · device 9876543a…");
});

test("your own message with no resolvable handle still says you", () => {
  assert.equal(sender({ own: true, handle: null }).name, "you");
});

// Pre-sender_user_id messages and purged accounts: the member list can't name
// them, and the row shows a device slice. The card matches it and reports
// only the id it actually has.
test("a sender the member list can't name falls back to the device slice", () => {
  const info = sender({ handle: null, userID: "", presence: undefined });
  assert.equal(info.name, "eeeeeeee");
  assert.equal(info.displayName, null);
  assert.equal(info.meta, "device 9876543a…");
});

test("a sender with no device at all reads as unknown", () => {
  const info = sender({ handle: null, userID: "", device: "" });
  assert.equal(info.name, "unknown sender");
  assert.equal(info.meta, "unknown sender");
});

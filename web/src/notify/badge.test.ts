// The badge counts what needs you, not what happened.

import { test } from "node:test";
import assert from "node:assert/strict";
import { badgeCount, type BadgeInputs } from "./badge.ts";

function input(over: Partial<BadgeInputs> = {}): BadgeInputs {
  return {
    unread: {},
    dmChannelIDs: new Set(),
    threadInboxUnreadTotal: 0,
    pendingIncomingCount: 0,
    ...over,
  };
}

const u = (lastSeq: number, lastReadSeq: number, mention = false) => ({
  lastSeq,
  lastReadSeq,
  mention,
});

test("nothing unread is zero", () => {
  assert.equal(badgeCount(input()), 0);
  assert.equal(badgeCount(input({ unread: { c1: u(5, 5) } })), 0);
});

test("an unread DM counts; an unread channel without a mention does not", () => {
  const unread = { dm1: u(3, 1), c1: u(9, 2) };
  assert.equal(badgeCount(input({ unread, dmChannelIDs: new Set(["dm1"]) })), 1);
});

test("a mention makes a channel count", () => {
  const unread = { c1: u(9, 2, true), c2: u(4, 1) };
  assert.equal(badgeCount(input({ unread })), 1);
});

test("a read channel with a stale mention flag does not count", () => {
  // The cursor is the truth; the flag only says why it counted while it
  // was unread.
  assert.equal(badgeCount(input({ unread: { c1: u(5, 5, true) } })), 0);
});

test("threads and friend requests add on top", () => {
  const inputs = input({
    unread: { dm1: u(2, 0), c1: u(7, 3, true) },
    dmChannelIDs: new Set(["dm1"]),
    threadInboxUnreadTotal: 2,
    pendingIncomingCount: 1,
  });
  assert.equal(badgeCount(inputs), 5);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { friendColumnMinWidth, friendLabel, longestFriendName } from "./friend-columns";

test("132-2: the longest label counts handles and the userID tail alike", () => {
  assert.equal(longestFriendName([]), 0);
  assert.equal(longestFriendName([{ handle: "alice", userID: "u1" }]), 5);
  // A friend without a handle shows the last eight characters of the id.
  const bare = { handle: null, userID: "0123456789abcdef" };
  assert.equal(friendLabel(bare), "89abcdef");
  assert.equal(longestFriendName([{ handle: "bob", userID: "u2" }, bare]), 8);
});

test("132-2: the column width is the name plus the row's fixed parts", () => {
  assert.equal(friendColumnMinWidth(7, false), "calc(7ch + 0.5rem + 26px)");
  // Roster avatars add the 16px picture and its 8px margin.
  assert.equal(friendColumnMinWidth(7, true), "calc(7ch + 0.5rem + 50px)");
  assert.equal(friendColumnMinWidth(0, false), "calc(0ch + 0.5rem + 26px)");
});

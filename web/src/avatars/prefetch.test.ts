// 112-10: A friend row needs the pictures of its DM before the user opens that DM.

import test from "node:test";
import assert from "node:assert/strict";
import { dmChannelsToList } from "./prefetch";

const CHANNELS = {
  "dm-1": { id: "dm-1", isDM: true, memberIDs: ["me", "u-1"] },
  "dm-2": { id: "dm-2", isDM: true, memberIDs: ["me", "u-2"] },
  "room": { id: "room", isDM: false, memberIDs: ["me", "u-1", "u-2"] },
  "group-dm": { id: "group-dm", isDM: true, memberIDs: ["me", "u-1", "u-2"] },
};

test("lists every two-person DM and skips rooms and group DMs", () => {
  assert.deepEqual(dmChannelsToList(CHANNELS, new Set()).sort(), ["dm-1", "dm-2"]);
});

test("skips a DM that is already in the asked set", () => {
  assert.deepEqual(dmChannelsToList(CHANNELS, new Set(["dm-1"])), ["dm-2"]);
});

test("returns an empty list and does not change the asked set when nothing is left", () => {
  const asked = new Set(["dm-1", "dm-2"]);
  assert.deepEqual(dmChannelsToList(CHANNELS, asked), []);
  assert.equal(asked.size, 2);
});

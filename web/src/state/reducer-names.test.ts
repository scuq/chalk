// 106-2: channel_updated -- the owner's rename / short-name change lands
// in the roster, and nothing else on the row moves.
//
//   * the two names are adopted in place
//   * an unknown channel is a no-op (the next listing carries its names)
//   * the same names again return the SAME state object, so the ack and
//     the channel_event push folding one after the other cost no render
//   * the read seed, key version and order are untouched

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import { initialState, type ChannelSummary, type AppState } from "./types.ts";

function channel(over: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    id: "ch-1",
    name: "[Gaming] General",
    isDM: false,
    createdBy: "u-1",
    createdAt: new Date(0),
    memberIDs: ["u-1", "u-2"],
    members: [],
    currentKeyVersion: 3,
    rotationPending: false,
    governanceMode: "dictator",
    channelType: "text",
    groupName: "Gaming",
    shortName: "",
    lastSeq: 42,
    lastReadSeq: 40,
    ...over,
  };
}

function loaded(): AppState {
  return reducer(initialState, {
    kind: "channels_loaded",
    channels: [channel(), channel({ id: "ch-2", name: "other" })],
  });
}

test("channel_updated adopts the new names in place", () => {
  const s = reducer(loaded(), {
    kind: "channel_updated",
    channelID: "ch-1",
    name: "Gaming Lounge",
    shortName: "lounge",
  });
  assert.equal(s.channels["ch-1"].name, "Gaming Lounge");
  assert.equal(s.channels["ch-1"].shortName, "lounge");
  // Nothing else on the row moved.
  assert.equal(s.channels["ch-1"].currentKeyVersion, 3);
  assert.equal(s.channels["ch-1"].lastSeq, 42);
  assert.equal(s.channels["ch-1"].lastReadSeq, 40);
  assert.equal(s.channels["ch-1"].groupName, "Gaming");
  // And the other channel is the same object.
  assert.equal(s.channels["ch-2"].name, "other");
});

test("a rename keeps the roster order", () => {
  const before = loaded();
  const s = reducer(before, {
    kind: "channel_updated",
    channelID: "ch-2",
    name: "renamed",
    shortName: "",
  });
  assert.deepEqual(s.channelOrder, before.channelOrder);
});

test("an unknown channel is a no-op", () => {
  const before = loaded();
  const s = reducer(before, {
    kind: "channel_updated",
    channelID: "ch-nope",
    name: "x",
    shortName: "",
  });
  assert.equal(s, before);
});

test("the same names again return the same state (ack then push)", () => {
  const once = reducer(loaded(), {
    kind: "channel_updated",
    channelID: "ch-1",
    name: "Gaming Lounge",
    shortName: "lounge",
  });
  const twice = reducer(once, {
    kind: "channel_updated",
    channelID: "ch-1",
    name: "Gaming Lounge",
    shortName: "lounge",
  });
  assert.equal(twice, once);
});

test("clearing the short name is a change; an absent short name reads as cleared", () => {
  const withShort = reducer(loaded(), {
    kind: "channel_updated",
    channelID: "ch-1",
    name: "[Gaming] General",
    shortName: "gaming",
  });
  const cleared = reducer(withShort, {
    kind: "channel_updated",
    channelID: "ch-1",
    name: "[Gaming] General",
    shortName: "",
  });
  assert.equal(cleared.channels["ch-1"].shortName, "");
  // A pre-106 row (shortName undefined) and "" are the same thing.
  const legacy = reducer(initialState, {
    kind: "channels_loaded",
    channels: [channel({ shortName: undefined })],
  });
  const same = reducer(legacy, {
    kind: "channel_updated",
    channelID: "ch-1",
    name: "[Gaming] General",
    shortName: "",
  });
  assert.equal(same, legacy);
});

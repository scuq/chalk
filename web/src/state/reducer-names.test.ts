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
import { normalizeBanner } from "./banner.ts";

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

// 111-1/111-7: the banner rides channel_updated with the names, as one
// normalized layout. Setting it is a change, clearing it is a change, and a
// summary that never had one must not look like a change to a row that never
// had one either.
test("channel_updated carries the banner layout", () => {
  const set = reducer(loaded(), {
    kind: "channel_updated",
    channelID: "ch-1",
    name: "[Gaming] General",
    shortName: "",
    banner: normalizeBanner({ attachment_id: "att-1", fit: "fit", zoom: 150 }),
  });
  assert.equal(set.channels["ch-1"].banner?.attachmentID, "att-1");
  assert.equal(set.channels["ch-1"].banner?.fit, "fit");
  assert.equal(set.channels["ch-1"].banner?.zoom, 150);

  // The same layout again is the same state: the ack and the push both
  // land, and only one of them may cost a render.
  const again = reducer(set, {
    kind: "channel_updated",
    channelID: "ch-1",
    name: "[Gaming] General",
    shortName: "",
    banner: normalizeBanner({ attachment_id: "att-1", fit: "fit", zoom: 150 }),
  });
  assert.equal(again, set);

  // One knob moved is a change, even with the same picture.
  const zoomed = reducer(set, {
    kind: "channel_updated",
    channelID: "ch-1",
    name: "[Gaming] General",
    shortName: "",
    banner: normalizeBanner({ attachment_id: "att-1", fit: "fit", zoom: 200 }),
  });
  assert.equal(zoomed.channels["ch-1"].banner?.zoom, 200);

  const cleared = reducer(set, {
    kind: "channel_updated",
    channelID: "ch-1",
    name: "[Gaming] General",
    shortName: "",
    banner: null,
  });
  assert.equal(cleared.channels["ch-1"].banner, null);

  // And a rename on a channel that never had a banner stays a no-op.
  const before = loaded();
  const renamed = reducer(before, {
    kind: "channel_updated",
    channelID: "ch-1",
    name: "[Gaming] General",
    shortName: "",
    banner: null,
  });
  const twice = reducer(renamed, {
    kind: "channel_updated",
    channelID: "ch-1",
    name: "[Gaming] General",
    shortName: "",
    banner: null,
  });
  assert.equal(twice, renamed);
});

// 112-3: the per-channel avatar map. A listing is that channel's whole
// truth; a push is one member's change.
test("avatars_loaded replaces a channel's map, avatar_updated edits it", () => {
  const loadedState = reducer(loaded(), {
    kind: "avatars_loaded",
    channelID: "ch-1",
    avatars: [
      { userID: "u-1", attachmentID: "att-1" },
      { userID: "u-2", attachmentID: "att-2" },
    ],
  });
  assert.deepEqual(loadedState.avatars["ch-1"], { "u-1": "att-1", "u-2": "att-2" });
  // Another channel is untouched by this one's listing.
  assert.equal(loadedState.avatars["ch-2"], undefined);

  // A listing that no longer mentions someone removes them: the picture was
  // taken down while this tab was away.
  const relisted = reducer(loadedState, {
    kind: "avatars_loaded",
    channelID: "ch-1",
    avatars: [{ userID: "u-2", attachmentID: "att-2" }],
  });
  assert.deepEqual(relisted.avatars["ch-1"], { "u-2": "att-2" });

  // A push adds, replaces, and removes.
  const added = reducer(relisted, {
    kind: "avatar_updated",
    channelID: "ch-1",
    userID: "u-3",
    attachmentID: "att-3",
  });
  assert.equal(added.avatars["ch-1"]["u-3"], "att-3");
  const removed = reducer(added, {
    kind: "avatar_updated",
    channelID: "ch-1",
    userID: "u-3",
    attachmentID: "",
  });
  assert.equal(removed.avatars["ch-1"]["u-3"], undefined);

  // The same push twice is the same state: the ack and the push both land.
  const again = reducer(removed, {
    kind: "avatar_updated",
    channelID: "ch-1",
    userID: "u-3",
    attachmentID: "",
  });
  assert.equal(again, removed);
});

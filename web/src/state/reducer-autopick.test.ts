// 130-5: The reducer tells a channel that it picked from a channel that the
// user selected. Click-to-join reads the flag. A voice room that is only the
// newest channel on a fresh launch does not count as opened.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import { initialState, type AppState, type ChannelSummary } from "./types.ts";

const ME = "user-me";

function baseState(): AppState {
  return { ...initialState, user: { id: ME, device: "dev-me", handle: "me" } };
}

function channel(over: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    id: "chan-1",
    name: "general",
    isDM: false,
    createdBy: ME,
    createdAt: new Date(0),
    memberIDs: [ME],
    members: [],
    currentKeyVersion: 1,
    rotationPending: false,
    governanceMode: "dictator",
    channelType: "text",
    groupName: "General",
    lastSeq: 0,
    lastReadSeq: 0,
    ...over,
  };
}

const room = channel({ id: "room", name: "room", channelType: "voice", createdAt: new Date(2000) });
const text = channel({ id: "text", name: "text", createdAt: new Date(1000) });

test("a fresh launch auto-picks the newest channel and says so", () => {
  const s = reducer(baseState(), { kind: "channels_loaded", channels: [text, room] });
  assert.equal(s.activeChannelID, "room");
  assert.equal(s.activeChannelAutoPicked, true);
});

test("a user selection clears the flag, and a later list refresh keeps it clear", () => {
  let s = reducer(baseState(), { kind: "channels_loaded", channels: [text, room] });
  s = reducer(s, { kind: "set_active_channel", channelID: "room" });
  assert.equal(s.activeChannelAutoPicked, false);
  s = reducer(s, { kind: "channels_loaded", channels: [text, room] });
  assert.equal(s.activeChannelID, "room");
  assert.equal(s.activeChannelAutoPicked, false);
});

test("clicking the auto-picked channel itself turns the pick into a selection", () => {
  let s = reducer(baseState(), { kind: "channels_loaded", channels: [text, room] });
  assert.equal(s.activeChannelAutoPicked, true);
  s = reducer(s, { kind: "set_active_channel", channelID: "room" });
  assert.equal(s.activeChannelID, "room");
  assert.equal(s.activeChannelAutoPicked, false);
});

test("when the selected channel vanishes, the fallback is a pick again", () => {
  let s = reducer(baseState(), { kind: "channels_loaded", channels: [text, room] });
  s = reducer(s, { kind: "set_active_channel", channelID: "text" });
  s = reducer(s, { kind: "channels_loaded", channels: [room] });
  assert.equal(s.activeChannelID, "room");
  assert.equal(s.activeChannelAutoPicked, true);
  s = reducer(s, { kind: "set_active_channel", channelID: "room" });
  s = reducer(s, { kind: "channel_removed", channelID: "room" });
  assert.equal(s.activeChannelID, null);
});

test("a channel added while nothing is active is a pick; a pending DM is a selection", () => {
  let s = reducer(baseState(), { kind: "channel_added", channel: room });
  assert.equal(s.activeChannelID, "room");
  assert.equal(s.activeChannelAutoPicked, true);
  const dm = channel({ id: "dm", isDM: true, memberIDs: [ME, "user-them"], createdAt: new Date(3000) });
  s = reducer({ ...s, dmPendingForUserID: "user-them" }, { kind: "channel_added", channel: dm });
  assert.equal(s.activeChannelID, "dm");
  assert.equal(s.activeChannelAutoPicked, false);
});

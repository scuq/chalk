// 53-1: parking is a screen state, not a navigation. What that has to mean in
// the reducer:
//
//   * parking leaves activeChannelID alone (every effect keyed on it is still
//     talking about that channel) but closes the thread panel, which renders
//     messages of its own
//   * clicking the channel you were already in un-parks -- the usual
//     "same channel, no-op" shortcut would otherwise strand you
//   * opening a thread from the inbox un-parks: you asked to read it
//
// 53-4 adds the way back: "unpark" restores the thread and the side panel that
// parking closed, and every other exit from the lot drops that memory rather
// than leaving it to be spent later on a screen you have moved on from.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import { initialState, type AppState, type ChannelSummary } from "./types.ts";

const CH = "chan-1";
const OTHER = "chan-2";

function channel(id: string): ChannelSummary {
  return {
    id,
    name: id,
    isDM: false,
    createdBy: "user-me",
    createdAt: new Date(0),
    memberIDs: ["user-me"],
    members: [{ userID: "user-me", handle: "me" }],
    currentKeyVersion: 1,
    rotationPending: false,
    governanceMode: "dictator",
    channelType: "text",
    groupName: "General",
    lastSeq: 0,
    lastReadSeq: 0,
  };
}

// A session that has already navigated into a channel: initialState starts
// parked (the parking lot is the startup screen), so unpark explicitly.
function baseState(over: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    parked: false,
    activeChannelID: CH,
    user: { id: "user-me", device: "dev-me", handle: "me" },
    channels: { [CH]: channel(CH), [OTHER]: channel(OTHER) },
    ...over,
  };
}

test("a fresh session starts parked", () => {
  assert.equal(initialState.parked, true);
});

test("parking keeps the active channel and closes the thread panel", () => {
  const s = reducer(
    baseState({ openThread: { channelID: CH, threadID: "t1" } }),
    { kind: "set_parked", parked: true },
  );
  assert.equal(s.parked, true);
  assert.equal(s.activeChannelID, CH);
  assert.equal(s.openThread, null);
});

test("parking closes the side panel, which can be showing message text", () => {
  const s = reducer(baseState({ openPanel: "search" }), {
    kind: "set_parked",
    parked: true,
  });
  assert.equal(s.openPanel, null);
});

test("leaving the parking lot does not re-open what parking closed", () => {
  const s = reducer(baseState({ parked: true, openPanel: null }), {
    kind: "set_parked",
    parked: false,
  });
  assert.equal(s.openPanel, null);
});

test("parking twice is a no-op", () => {
  const parked = baseState({ parked: true });
  assert.equal(reducer(parked, { kind: "set_parked", parked: true }), parked);
});

test("re-selecting the channel you were parked on comes back to it", () => {
  const s = reducer(baseState({ parked: true }), {
    kind: "set_active_channel",
    channelID: CH,
  });
  assert.equal(s.parked, false);
  assert.equal(s.activeChannelID, CH);
});

test("selecting any other channel un-parks too", () => {
  const s = reducer(baseState({ parked: true }), {
    kind: "set_active_channel",
    channelID: OTHER,
  });
  assert.equal(s.parked, false);
  assert.equal(s.activeChannelID, OTHER);
});

test("the same-channel shortcut still holds when not parked", () => {
  const s = baseState();
  assert.equal(reducer(s, { kind: "set_active_channel", channelID: CH }), s);
});

test("opening a thread from the inbox un-parks", () => {
  const s = reducer(baseState({ parked: true }), {
    kind: "open_thread_from_inbox",
    channelID: OTHER,
    threadID: "t9",
  });
  assert.equal(s.parked, false);
  assert.deepEqual(s.openThread, { channelID: OTHER, threadID: "t9" });
});

// ---- 53-4: the way back ------------------------------------------------

test("unpark puts back the thread and the panel parking closed", () => {
  const before = baseState({
    openThread: { channelID: CH, threadID: "t1" },
    openPanel: "threads",
  });
  const parked = reducer(before, { kind: "set_parked", parked: true });
  assert.equal(parked.openThread, null);
  assert.equal(parked.openPanel, null);

  const back = reducer(parked, { kind: "unpark" });
  assert.equal(back.parked, false);
  assert.equal(back.activeChannelID, CH);
  assert.deepEqual(back.openThread, { channelID: CH, threadID: "t1" });
  assert.equal(back.openPanel, "threads");
  assert.equal(back.parkedReturn, null);
});

test("unpark from a bare screen brings back a bare screen", () => {
  const parked = reducer(baseState(), { kind: "set_parked", parked: true });
  const back = reducer(parked, { kind: "unpark" });
  assert.equal(back.openThread, null);
  assert.equal(back.openPanel, null);
});

test("unpark while not parked is a no-op", () => {
  const s = baseState();
  assert.equal(reducer(s, { kind: "unpark" }), s);
});

test("a thread whose channel went away while parked is not restored", () => {
  const parked = reducer(
    baseState({ openThread: { channelID: OTHER, threadID: "t1" } }),
    { kind: "set_parked", parked: true },
  );
  const gone = { ...parked, channels: { [CH]: channel(CH) } };
  const back = reducer(gone, { kind: "unpark" });
  assert.equal(back.openThread, null);
});

test("coming back re-freezes the unread window over what arrived while parked", () => {
  const parked = reducer(
    baseState({ unread: { [CH]: { lastSeq: 4, lastReadSeq: 1, mention: false } } }),
    { kind: "set_parked", parked: true },
  );
  const back = reducer(parked, { kind: "unpark" });
  assert.deepEqual(back.unreadMarks, { [CH]: { afterSeq: 1, throughSeq: 4 } });
});

test("picking a channel spends the memory rather than saving it for later", () => {
  const parked = reducer(
    baseState({ openThread: { channelID: CH, threadID: "t1" }, openPanel: "search" }),
    { kind: "set_parked", parked: true },
  );
  const navigated = reducer(parked, { kind: "set_active_channel", channelID: OTHER });
  assert.equal(navigated.parkedReturn, null);
  // Parking again from there remembers the new screen, not the old one.
  const reparked = reducer(navigated, { kind: "set_parked", parked: true });
  assert.deepEqual(reparked.parkedReturn, { openThread: null, openPanel: null });
});

test("leaving the lot any other way forgets what was open", () => {
  const parked = reducer(
    baseState({ openPanel: "search" }),
    { kind: "set_parked", parked: true },
  );
  const left = reducer(parked, { kind: "set_parked", parked: false });
  assert.equal(left.parkedReturn, null);
  assert.equal(left.openPanel, null);
  // And an "unpark" that arrives afterwards has nothing to spend.
  assert.equal(reducer(left, { kind: "unpark" }), left);
});

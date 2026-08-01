// 53-1: parking is a screen state, not a navigation. What that has to mean in
// the reducer:
//
//   * parking leaves activeChannelID alone (every effect keyed on it is still
//     talking about that channel) but closes the thread panel, which renders
//     messages of its own
//   * clicking the channel you were already in un-parks -- the usual
//     "same channel, no-op" shortcut would otherwise strand you
//   * opening a thread from the inbox un-parks: you asked to read it

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import { initialState, type AppState } from "./types.ts";

const CH = "chan-1";
const OTHER = "chan-2";

// A session that has already navigated into a channel: initialState starts
// parked (the parking lot is the startup screen), so unpark explicitly.
function baseState(over: Partial<AppState> = {}): AppState {
  return {
    ...initialState,
    parked: false,
    activeChannelID: CH,
    user: { id: "user-me", device: "dev-me", handle: "me" },
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

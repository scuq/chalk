// Phase 33: the unread + mention state machine in the reducer.
//
// The properties that matter for the sidebar dot:
//   * an incoming message from someone else creates unread
//   * your own message never does, on any device
//   * cursors only move forward, so a stale read_state can't resurrect a dot
//   * a mention flag cannot outlive the unread dot it decorates

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import {
  hasUnread,
  initialState,
  type AppState,
  type ChannelSummary,
  type Message,
} from "./types.ts";

const ME = "user-me";
const THEM = "user-them";
const CH = "chan-1";

function baseState(): AppState {
  return {
    ...initialState,
    messages: {},
    unread: {},
    user: { id: ME, device: "dev-me", handle: "me" },
  };
}

function channel(over: Partial<ChannelSummary> = {}): ChannelSummary {
  return {
    id: CH,
    name: "general",
    isDM: false,
    createdBy: ME,
    createdAt: new Date(0),
    memberIDs: [ME, THEM],
    members: [],
    currentKeyVersion: 1,
    rotationPending: false,
    governanceMode: "dictator",
    channelType: "text",
    lastSeq: 0,
    lastReadSeq: 0,
    ...over,
  };
}

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    channelID: CH,
    seq: 1,
    sender: "dev-them",
    senderUserID: THEM,
    ts: new Date(1000),
    body: "hi",
    ...over,
  };
}

test("a message from someone else marks the channel unread", () => {
  const s = reducer(baseState(), { kind: "message", message: msg({ seq: 5 }) });
  assert.equal(s.unread[CH].lastSeq, 5);
  assert.equal(s.unread[CH].lastReadSeq, 0);
  assert.equal(hasUnread(s.unread[CH]), true);
});

test("your own message does not mark the channel unread", () => {
  const s = reducer(baseState(), {
    kind: "message",
    message: msg({ senderUserID: ME, seq: 5 }),
  });
  assert.equal(s.unread[CH].lastSeq, 5);
  assert.equal(s.unread[CH].lastReadSeq, 5);
  assert.equal(hasUnread(s.unread[CH]), false);
});

test("read_state clears the dot", () => {
  let s = reducer(baseState(), { kind: "message", message: msg({ seq: 5 }) });
  s = reducer(s, { kind: "read_state", channelID: CH, lastReadSeq: 5 });
  assert.equal(hasUnread(s.unread[CH]), false);
});

test("a stale read_state cannot rewind the cursor", () => {
  let s = reducer(baseState(), { kind: "message", message: msg({ seq: 9 }) });
  s = reducer(s, { kind: "read_state", channelID: CH, lastReadSeq: 9 });
  s = reducer(s, { kind: "read_state", channelID: CH, lastReadSeq: 3 });
  assert.equal(s.unread[CH].lastReadSeq, 9);
  assert.equal(hasUnread(s.unread[CH]), false);
});

test("an out-of-order message cannot rewind the high-water seq", () => {
  let s = reducer(baseState(), { kind: "message", message: msg({ seq: 9 }) });
  s = reducer(s, { kind: "message", message: msg({ id: "m2", seq: 4 }) });
  assert.equal(s.unread[CH].lastSeq, 9);
});

test("mention_set marks a mention alongside the unread dot", () => {
  let s = reducer(baseState(), { kind: "message", message: msg({ seq: 5 }) });
  s = reducer(s, { kind: "mention_set", channelID: CH });
  assert.equal(s.unread[CH].mention, true);
  assert.equal(hasUnread(s.unread[CH]), true);
});

test("reading the channel clears the mention with the dot", () => {
  let s = reducer(baseState(), { kind: "message", message: msg({ seq: 5 }) });
  s = reducer(s, { kind: "mention_set", channelID: CH });
  s = reducer(s, { kind: "read_state", channelID: CH, lastReadSeq: 5 });
  assert.equal(s.unread[CH].mention, false);
});

test("a late mention scan cannot resurrect a mention on a read channel", () => {
  let s = reducer(baseState(), { kind: "message", message: msg({ seq: 5 }) });
  s = reducer(s, { kind: "read_state", channelID: CH, lastReadSeq: 5 });
  s = reducer(s, { kind: "mention_set", channelID: CH });
  assert.equal(s.unread[CH].mention, false);
});

test("channels_loaded seeds unread from the server cursors", () => {
  const s = reducer(baseState(), {
    kind: "channels_loaded",
    channels: [channel({ lastSeq: 12, lastReadSeq: 7 })],
  });
  assert.equal(s.unread[CH].lastSeq, 12);
  assert.equal(s.unread[CH].lastReadSeq, 7);
  assert.equal(hasUnread(s.unread[CH]), true);
});

test("channels_loaded replaces stale cached unread rather than merging", () => {
  // Another device read past seq 12 while we were offline; the fresh listing
  // must win over whatever this client had cached.
  let s = reducer(baseState(), { kind: "message", message: msg({ seq: 12 }) });
  assert.equal(hasUnread(s.unread[CH]), true);
  s = reducer(s, {
    kind: "channels_loaded",
    channels: [channel({ lastSeq: 12, lastReadSeq: 12 })],
  });
  assert.equal(hasUnread(s.unread[CH]), false);
});

test("channel_added seeds unread for a newly joined channel", () => {
  const s = reducer(baseState(), {
    kind: "channel_added",
    channel: channel({ lastSeq: 30, lastReadSeq: 30 }),
  });
  assert.equal(hasUnread(s.unread[CH]), false);
});

test("channel_removed drops the channel's unread state", () => {
  let s = reducer(baseState(), { kind: "message", message: msg({ seq: 5 }) });
  s = reducer(s, { kind: "channel_added", channel: channel() });
  s = reducer(s, { kind: "channel_removed", channelID: CH });
  assert.equal(s.unread[CH], undefined);
});

test("hasUnread is false for a channel with no state", () => {
  assert.equal(hasUnread(undefined), false);
});

// ---- 33-4: the frozen unread window behind the divider ------------------

test("entering a channel with unread freezes the window", () => {
  let s = reducer(baseState(), {
    kind: "channels_loaded",
    channels: [channel({ lastSeq: 10, lastReadSeq: 4 })],
  });
  s = reducer(s, { kind: "set_active_channel", channelID: CH });
  assert.deepEqual(s.unreadMarks[CH], { afterSeq: 4, throughSeq: 10 });
});

test("entering a caught-up channel leaves no mark", () => {
  let s = reducer(baseState(), {
    kind: "channels_loaded",
    channels: [channel({ lastSeq: 10, lastReadSeq: 10 })],
  });
  s = reducer(s, { kind: "set_active_channel", channelID: CH });
  assert.equal(s.unreadMarks[CH], undefined);
});

test("the mark survives the channel being marked read", () => {
  // This is the whole point: opening a channel reads it within a round-trip,
  // so a divider keyed on the live cursor would vanish on arrival.
  let s = reducer(baseState(), {
    kind: "channels_loaded",
    channels: [channel({ lastSeq: 10, lastReadSeq: 4 })],
  });
  s = reducer(s, { kind: "set_active_channel", channelID: CH });
  s = reducer(s, { kind: "read_state", channelID: CH, lastReadSeq: 10 });
  assert.equal(hasUnread(s.unread[CH]), false);
  assert.deepEqual(s.unreadMarks[CH], { afterSeq: 4, throughSeq: 10 });
});

test("messages arriving while watching do not extend the window", () => {
  let s = reducer(baseState(), {
    kind: "channels_loaded",
    channels: [channel({ lastSeq: 10, lastReadSeq: 4 })],
  });
  s = reducer(s, { kind: "set_active_channel", channelID: CH });
  s = reducer(s, { kind: "message", message: msg({ id: "m99", seq: 11 }) });
  assert.deepEqual(s.unreadMarks[CH], { afterSeq: 4, throughSeq: 10 });
});

test("leaving a channel discards its mark", () => {
  let s = reducer(baseState(), {
    kind: "channels_loaded",
    channels: [
      channel({ lastSeq: 10, lastReadSeq: 4 }),
      channel({ id: "chan-2", lastSeq: 0, lastReadSeq: 0 }),
    ],
  });
  s = reducer(s, { kind: "set_active_channel", channelID: CH });
  assert.notEqual(s.unreadMarks[CH], undefined);
  s = reducer(s, { kind: "set_active_channel", channelID: "chan-2" });
  assert.equal(s.unreadMarks[CH], undefined);
});

test("reconnecting into a channel with new messages marks it", () => {
  // The auto-selected channel on channels_loaded never goes through
  // set_active_channel, so that path has to capture the window too.
  const s = reducer(baseState(), {
    kind: "channels_loaded",
    channels: [channel({ lastSeq: 22, lastReadSeq: 15 })],
  });
  assert.equal(s.activeChannelID, CH);
  assert.deepEqual(s.unreadMarks[CH], { afterSeq: 15, throughSeq: 22 });
});

test("refreshing the mark re-freezes against the current cursor", () => {
  // Tab regains focus after messages piled up on the open channel.
  let s = reducer(baseState(), {
    kind: "channels_loaded",
    channels: [channel({ lastSeq: 5, lastReadSeq: 5 })],
  });
  assert.equal(s.unreadMarks[CH], undefined);
  s = reducer(s, { kind: "message", message: msg({ id: "m6", seq: 6 }) });
  s = reducer(s, { kind: "message", message: msg({ id: "m7", seq: 7 }) });
  s = reducer(s, { kind: "unread_mark_refresh", channelID: CH });
  assert.deepEqual(s.unreadMarks[CH], { afterSeq: 5, throughSeq: 7 });
});

test("refreshing on a caught-up channel clears any stale mark", () => {
  let s = reducer(baseState(), {
    kind: "channels_loaded",
    channels: [channel({ lastSeq: 10, lastReadSeq: 4 })],
  });
  s = reducer(s, { kind: "read_state", channelID: CH, lastReadSeq: 10 });
  s = reducer(s, { kind: "unread_mark_refresh", channelID: CH });
  assert.equal(s.unreadMarks[CH], undefined);
});

test("refreshing with no active channel is a no-op", () => {
  const s = reducer(baseState(), {
    kind: "unread_mark_refresh",
    channelID: null,
  });
  assert.deepEqual(s.unreadMarks, {});
});

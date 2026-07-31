// 62-3: the per-channel newest-message activity state machine.
//
// The properties the unified conversation list depends on:
//   * a listing seeds activity; a re-listing merges monotonically by seq
//   * a channel_event summary (which carries NO activity) can't wipe it
//   * a live message supersedes older activity and brings a free preview
//   * equal seq keeps a decrypted preview (listing re-delivers ciphertext
//     for a message this client already decrypted live)
//   * edit/delete of the newest message update the preview by msgID match
//   * channel_removed / voice_purged drop the entry
//   * a warm-loop preview lands only while its seq still matches

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import {
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
    activity: {},
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
    groupName: "General",
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

const seeded = (over: Partial<ChannelSummary> = {}) =>
  channel({
    lastMsgID: "m5",
    lastMsgTS: 5000,
    lastMsgSeq: 5,
    lastMsgSender: THEM,
    lastMsgDeleted: false,
    ...over,
  });

test("channels_loaded seeds activity from the listing", () => {
  const s = reducer(baseState(), { kind: "channels_loaded", channels: [seeded()] });
  assert.deepEqual(s.activity[CH], {
    msgID: "m5",
    ts: 5000,
    seq: 5,
    senderUserID: THEM,
    preview: null,
    deleted: false,
  });
});

test("a summary without activity seeds nothing", () => {
  const s = reducer(baseState(), { kind: "channels_loaded", channels: [channel()] });
  assert.equal(s.activity[CH], undefined);
});

test("a zero-activity channel_added (channel_event summary) can't wipe activity", () => {
  let s = reducer(baseState(), { kind: "channels_loaded", channels: [seeded()] });
  // channel_added is idempotent for known channels; simulate the re-listing
  // shape instead: a listing whose summary lost its activity fields.
  s = reducer(s, { kind: "channels_loaded", channels: [channel()] });
  assert.equal(s.activity[CH].seq, 5);
});

test("a re-listing with lower seq cannot rewind activity", () => {
  let s = reducer(baseState(), { kind: "channels_loaded", channels: [seeded()] });
  s = reducer(s, {
    kind: "channels_loaded",
    channels: [seeded({ lastMsgID: "m3", lastMsgSeq: 3, lastMsgTS: 3000 })],
  });
  assert.equal(s.activity[CH].seq, 5);
});

test("channels absent from a listing drop their activity", () => {
  let s = reducer(baseState(), { kind: "channels_loaded", channels: [seeded()] });
  s = reducer(s, { kind: "channels_loaded", channels: [] });
  assert.equal(s.activity[CH], undefined);
});

test("a live message supersedes older activity with a decrypted preview", () => {
  let s = reducer(baseState(), { kind: "channels_loaded", channels: [seeded()] });
  s = reducer(s, {
    kind: "message",
    message: msg({ id: "m6", seq: 6, ts: new Date(6000), body: "fresh words" }),
  });
  assert.equal(s.activity[CH].seq, 6);
  assert.equal(s.activity[CH].msgID, "m6");
  assert.equal(s.activity[CH].preview, "fresh words");
  assert.equal(s.activity[CH].senderUserID, THEM);
});

test("a re-listing at the same seq keeps the decrypted preview", () => {
  let s = reducer(baseState(), {
    kind: "message",
    message: msg({ id: "m5", seq: 5, ts: new Date(5000), body: "live text" }),
  });
  assert.equal(s.activity[CH].preview, "live text");
  s = reducer(s, { kind: "channels_loaded", channels: [seeded()] });
  assert.equal(s.activity[CH].seq, 5);
  assert.equal(s.activity[CH].preview, "live text");
});

test("an out-of-order message cannot rewind activity", () => {
  let s = reducer(baseState(), {
    kind: "message",
    message: msg({ id: "m9", seq: 9, ts: new Date(9000), body: "newest" }),
  });
  s = reducer(s, {
    kind: "message",
    message: msg({ id: "m4", seq: 4, ts: new Date(4000), body: "старое" }),
  });
  assert.equal(s.activity[CH].seq, 9);
  assert.equal(s.activity[CH].preview, "newest");
});

test("deleting the newest message tombstones the preview", () => {
  let s = reducer(baseState(), {
    kind: "message",
    message: msg({ id: "m5", seq: 5, body: "soon gone" }),
  });
  s = reducer(s, {
    kind: "message_deleted",
    channelID: CH,
    messageID: "m5",
    deletedBy: THEM,
    deletedAt: new Date(6000),
  });
  assert.equal(s.activity[CH].deleted, true);
  assert.equal(s.activity[CH].preview, "[message deleted]");
});

test("deleting an older message leaves the preview alone", () => {
  let s = reducer(baseState(), {
    kind: "message",
    message: msg({ id: "m5", seq: 5, body: "still here" }),
  });
  s = reducer(s, {
    kind: "message_deleted",
    channelID: CH,
    messageID: "m2",
    deletedBy: THEM,
    deletedAt: new Date(6000),
  });
  assert.equal(s.activity[CH].deleted, false);
  assert.equal(s.activity[CH].preview, "still here");
});

test("editing the newest message re-renders the preview", () => {
  let s = reducer(baseState(), {
    kind: "message",
    message: msg({ id: "m5", seq: 5, body: "tpyo" }),
  });
  s = reducer(s, {
    kind: "message_edited",
    channelID: CH,
    messageID: "m5",
    body: "typo, fixed",
    keyVersion: 1,
    editedAt: new Date(6000),
  });
  assert.equal(s.activity[CH].preview, "typo, fixed");
});

test("channel_removed and voice_purged drop the activity entry", () => {
  let s = reducer(baseState(), { kind: "channels_loaded", channels: [seeded()] });
  const removed = reducer(s, { kind: "channel_removed", channelID: CH });
  assert.equal(removed.activity[CH], undefined);
  const purged = reducer(s, { kind: "voice_purged", channelID: CH });
  assert.equal(purged.activity[CH], undefined);
});

test("channel_preview lands only while its seq still matches", () => {
  let s = reducer(baseState(), { kind: "channels_loaded", channels: [seeded()] });
  s = reducer(s, { kind: "channel_preview", channelID: CH, seq: 5, preview: "decrypted" });
  assert.equal(s.activity[CH].preview, "decrypted");
  // a live message supersedes; a stale decrypt result must not overwrite it
  s = reducer(s, {
    kind: "message",
    message: msg({ id: "m6", seq: 6, ts: new Date(6000), body: "newer live" }),
  });
  s = reducer(s, { kind: "channel_preview", channelID: CH, seq: 5, preview: "stale" });
  assert.equal(s.activity[CH].preview, "newer live");
});

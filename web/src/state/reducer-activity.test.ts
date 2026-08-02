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

// ---- the three paths that used to know a newer message and not say so ----

test("history carries the pointer forward when it holds a newer message", () => {
  // The key-ready refetch (23g) is the common case: it re-decrypts bodies that
  // first rendered as the "key not available" placeholder, and the conversation
  // list used to keep previewing whatever it had from before.
  let s = reducer(baseState(), { kind: "channels_loaded", channels: [seeded()] });
  s = reducer(s, {
    kind: "history_loaded",
    channelID: CH,
    messages: [
      msg({ id: "m5", seq: 5, ts: new Date(5000), body: "older" }),
      msg({ id: "m7", seq: 7, ts: new Date(7000), body: "newest of the page" }),
    ],
  });
  assert.equal(s.activity[CH].seq, 7);
  assert.equal(s.activity[CH].msgID, "m7");
  assert.equal(s.activity[CH].preview, "newest of the page");
});

test("an older history page cannot rewind the pointer", () => {
  let s = reducer(baseState(), { kind: "channels_loaded", channels: [seeded()] });
  s = reducer(s, {
    kind: "history_loaded",
    channelID: CH,
    messages: [msg({ id: "m2", seq: 2, ts: new Date(2000), body: "scrollback" })],
  });
  assert.equal(s.activity[CH].seq, 5);
  assert.equal(s.activity[CH].preview, null);
});

test("history at the pointer's own seq leaves a live preview alone", () => {
  // Strictly-newer only: at equal seq the live path already supplied the
  // plaintext, and a history row whose key has not settled would replace it
  // with a placeholder.
  let s = reducer(baseState(), {
    kind: "message",
    message: msg({ id: "m6", seq: 6, ts: new Date(6000), body: "live and readable" }),
  });
  s = reducer(s, {
    kind: "history_loaded",
    channelID: CH,
    messages: [msg({ id: "m6", seq: 6, ts: new Date(6000), body: "[unreadable]" })],
  });
  assert.equal(s.activity[CH].preview, "live and readable");
});

test("a push the history fetch beat to the message still moves the pointer", () => {
  // Deduped by id, so the message itself is a no-op -- but the push is the one
  // carrying the decrypted body, and dropping it whole left the list showing
  // the message before it.
  let s = reducer(baseState(), { kind: "channels_loaded", channels: [seeded()] });
  s = reducer(s, {
    kind: "history_loaded",
    channelID: CH,
    messages: [msg({ id: "m6", seq: 6, ts: new Date(6000), body: "[unreadable]" })],
  });
  s = reducer(s, {
    kind: "message",
    message: msg({ id: "m6", seq: 6, ts: new Date(6000), body: "fresh words" }),
  });
  assert.equal(s.activity[CH].preview, "fresh words");
});

test("send_ack puts our own message on the pointer at the seq the server gave it", () => {
  // The optimistic row's seq is a guess -- highest LOADED seq + 1 -- so sending
  // in a channel whose history has not arrived guesses 1, far below the real
  // one, and bumpActivity rightly refuses it. No echo comes back to the sender,
  // so without the ack the list keeps previewing the message before yours.
  let s = reducer(baseState(), { kind: "channels_loaded", channels: [seeded()] });
  s = reducer(s, {
    kind: "message",
    message: msg({
      id: "local-1",
      seq: 1,
      ts: new Date(9000),
      sender: "dev-me",
      senderUserID: ME,
      body: "mine, sent blind",
      clientMsgID: "local-1",
    }),
  });
  assert.equal(s.activity[CH].seq, 5, "the guess is below the listing's pointer");
  s = reducer(s, {
    kind: "send_ack",
    channelID: CH,
    clientMsgID: "local-1",
    id: "m6",
    seq: 6,
    ts: new Date(9000),
  });
  assert.equal(s.activity[CH].seq, 6);
  assert.equal(s.activity[CH].msgID, "m6");
  assert.equal(s.activity[CH].senderUserID, ME);
  assert.equal(s.activity[CH].preview, "mine, sent blind");
});

test("send_ack cannot rewind the pointer past a message that landed after it", () => {
  let s = reducer(baseState(), {
    kind: "message",
    message: msg({
      id: "local-1",
      seq: 1,
      sender: "dev-me",
      senderUserID: ME,
      body: "mine",
      clientMsgID: "local-1",
    }),
  });
  s = reducer(s, {
    kind: "message",
    message: msg({ id: "m9", seq: 9, ts: new Date(9000), body: "theirs, newer" }),
  });
  s = reducer(s, {
    kind: "send_ack",
    channelID: CH,
    clientMsgID: "local-1",
    id: "m2",
    seq: 2,
    ts: new Date(2000),
  });
  assert.equal(s.activity[CH].seq, 9);
  assert.equal(s.activity[CH].preview, "theirs, newer");
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

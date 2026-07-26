// 45-2: the voice_purged reducer case.
//
// The properties that matter: the channel's feed empties, everything derived
// from those messages (threads, their cursors, reactions, the unread window,
// the inbox rows) goes with them, an open thread in that channel closes, and
// no other channel is touched.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import { initialState, type Message, type AppState, type ThreadInboxRow } from "./types.ts";

function msg(over: Partial<Message>): Message {
  return {
    id: "m1",
    channelID: "voice-1",
    seq: 1,
    sender: "dev-1",
    senderUserID: "user-1",
    ts: new Date(1000),
    body: "hi",
    ...over,
  };
}

function inboxRow(channelID: string, threadID: string): ThreadInboxRow {
  return {
    channelID,
    threadID,
    headSeq: 1,
    headTS: new Date(1000),
    lastReplySeq: 2,
    lastReplyTS: new Date(2000),
    replyCount: 1,
  };
}

// A voice channel holding a head with one reply, plus a text channel that must
// come through untouched.
function stateWithScratch(): AppState {
  return {
    ...initialState,
    messages: {
      "voice-1": [msg({ id: "head", seq: 1 }), msg({ id: "m2", seq: 2 })],
      "text-1": [msg({ id: "t1", channelID: "text-1" })],
    },
    historyLoaded: { "voice-1": true, "text-1": true },
    threadMessages: {
      head: [msg({ id: "r1", seq: 3, threadID: "head" })],
      "other-head": [msg({ id: "r9", channelID: "text-1", threadID: "other-head" })],
    },
    threadLoaded: { head: true, "other-head": true },
    threadSeen: { head: 3, "other-head": 1 },
    threadMentions: { head: true, "other-head": true },
    reactions: {
      head: [{ userID: "u1", emoji: ["👍"] }],
      r1: [{ userID: "u1", emoji: ["🎉"] }],
      t1: [{ userID: "u1", emoji: ["🚀"] }],
    },
    unread: { "voice-1": { lastSeq: 2, lastReadSeq: 0, mention: true } },
    unreadMarks: { "voice-1": { afterSeq: 0, throughSeq: 2 } },
    openThread: { channelID: "voice-1", threadID: "head" },
    threadInboxActive: [inboxRow("voice-1", "head"), inboxRow("text-1", "other-head")],
    threadInboxAgedUnread: [inboxRow("voice-1", "head")],
  };
}

test("purging empties the channel's feed but leaves it loaded", () => {
  const s = reducer(stateWithScratch(), { kind: "voice_purged", channelID: "voice-1" });
  assert.deepEqual(s.messages["voice-1"], []);
  assert.equal(s.historyLoaded["voice-1"], true);
});

test("purging drops the threads, their cursors and their reactions", () => {
  const s = reducer(stateWithScratch(), { kind: "voice_purged", channelID: "voice-1" });
  assert.equal("head" in s.threadMessages, false);
  assert.equal("head" in s.threadLoaded, false);
  assert.equal("head" in s.threadSeen, false);
  assert.equal("head" in s.threadMentions, false);
  // Both the head's reactions and its replies' reactions.
  assert.equal("head" in s.reactions, false);
  assert.equal("r1" in s.reactions, false);
});

test("purging clears the unread window and closes a thread open in it", () => {
  const s = reducer(stateWithScratch(), { kind: "voice_purged", channelID: "voice-1" });
  assert.equal("voice-1" in s.unread, false);
  assert.equal("voice-1" in s.unreadMarks, false);
  assert.equal(s.openThread, null);
});

test("purging removes the channel's inbox rows from both lists", () => {
  const s = reducer(stateWithScratch(), { kind: "voice_purged", channelID: "voice-1" });
  assert.deepEqual(
    s.threadInboxActive.map((r) => r.channelID),
    ["text-1"],
  );
  assert.deepEqual(s.threadInboxAgedUnread, []);
});

test("no other channel is touched", () => {
  const s = reducer(stateWithScratch(), { kind: "voice_purged", channelID: "voice-1" });
  assert.equal(s.messages["text-1"]!.length, 1);
  assert.equal("other-head" in s.threadMessages, true);
  assert.equal("other-head" in s.threadSeen, true);
  assert.deepEqual(s.reactions["t1"], [{ userID: "u1", emoji: ["🚀"] }]);
});

test("purging a channel with nothing in it is harmless", () => {
  const s = reducer(initialState, { kind: "voice_purged", channelID: "voice-1" });
  assert.deepEqual(s.messages["voice-1"], []);
  assert.equal(s.openThread, null);
});

test("a thread open in ANOTHER channel survives the purge", () => {
  const base = { ...stateWithScratch(), openThread: { channelID: "text-1", threadID: "other-head" } };
  const s = reducer(base, { kind: "voice_purged", channelID: "voice-1" });
  assert.deepEqual(s.openThread, { channelID: "text-1", threadID: "other-head" });
});

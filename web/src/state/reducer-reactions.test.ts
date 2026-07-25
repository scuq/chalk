// 37-5: the reaction reducer cases.
//
// The properties that matter: a set REPLACES that member's previous set (never
// merges), an empty set is stored as absence, reactions survive the
// history_loaded overwrite that clobbers Message rows, and a tombstone takes
// its reactions with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import { initialState, type Message, type AppState } from "./types.ts";

function baseState(): AppState {
  return { ...initialState, messages: {}, threadMessages: {}, reactions: {} };
}

function msg(over: Partial<Message>): Message {
  return {
    id: "m1",
    channelID: "chan-1",
    seq: 1,
    sender: "dev-1",
    senderUserID: "user-1",
    ts: new Date(1000),
    body: "hi",
    ...over,
  };
}

test("a reaction set is stored per member", () => {
  let s = baseState();
  s = reducer(s, { kind: "reaction_set", messageID: "m1", userID: "u1", emoji: ["👍"] });
  s = reducer(s, { kind: "reaction_set", messageID: "m1", userID: "u2", emoji: ["🎉"] });
  assert.deepEqual(s.reactions["m1"], [
    { userID: "u1", emoji: ["👍"] },
    { userID: "u2", emoji: ["🎉"] },
  ]);
});

test("a second set from the same member REPLACES, never merges", () => {
  let s = baseState();
  s = reducer(s, { kind: "reaction_set", messageID: "m1", userID: "u1", emoji: ["👍"] });
  s = reducer(s, { kind: "reaction_set", messageID: "m1", userID: "u1", emoji: ["🎉", "🚀"] });
  assert.equal(s.reactions["m1"]!.length, 1);
  assert.deepEqual(s.reactions["m1"]![0]!.emoji, ["🎉", "🚀"]);
});

test("clearing to an empty set removes the member, then the whole entry", () => {
  let s = baseState();
  s = reducer(s, { kind: "reaction_set", messageID: "m1", userID: "u1", emoji: ["👍"] });
  s = reducer(s, { kind: "reaction_set", messageID: "m1", userID: "u2", emoji: ["👍"] });
  s = reducer(s, { kind: "reaction_set", messageID: "m1", userID: "u1", emoji: [] });
  assert.deepEqual(s.reactions["m1"], [{ userID: "u2", emoji: ["👍"] }]);

  // Last one out drops the key entirely rather than leaving an empty array.
  s = reducer(s, { kind: "reaction_set", messageID: "m1", userID: "u2", emoji: [] });
  assert.equal("m1" in s.reactions, false);
});

test("clearing a message nobody reacted to is a no-op on the same state", () => {
  const s = baseState();
  const after = reducer(s, {
    kind: "reaction_set",
    messageID: "unknown",
    userID: "u1",
    emoji: [],
  });
  assert.equal(after, s);
});

test("reactions_merged replaces per message and drops empties", () => {
  let s = baseState();
  s = reducer(s, { kind: "reaction_set", messageID: "m1", userID: "u1", emoji: ["👍"] });
  s = reducer(s, { kind: "reaction_set", messageID: "m2", userID: "u1", emoji: ["🎉"] });
  s = reducer(s, {
    kind: "reactions_merged",
    byMessageID: { m1: [{ userID: "u9", emoji: ["🚀"] }], m2: [] },
  });
  assert.deepEqual(s.reactions["m1"], [{ userID: "u9", emoji: ["🚀"] }]);
  assert.equal("m2" in s.reactions, false);
});

test("an empty merge returns the same state reference", () => {
  const s = baseState();
  assert.equal(reducer(s, { kind: "reactions_merged", byMessageID: {} }), s);
});

test("reactions survive history_loaded, which overwrites message rows", () => {
  // This is the whole reason reactions are a parallel record and not a field
  // on Message: history rows replace message objects wholesale by id.
  let s = baseState();
  s = reducer(s, { kind: "message", message: msg({ id: "m1" }) });
  s = reducer(s, { kind: "reaction_set", messageID: "m1", userID: "u1", emoji: ["👍"] });
  s = reducer(s, {
    kind: "history_loaded",
    channelID: "chan-1",
    messages: [msg({ id: "m1", body: "hi (from server)" })],
  });
  assert.deepEqual(s.reactions["m1"], [{ userID: "u1", emoji: ["👍"] }]);
});

test("deleting a message takes its reactions with it", () => {
  let s = baseState();
  s = reducer(s, { kind: "message", message: msg({ id: "m1" }) });
  s = reducer(s, { kind: "reaction_set", messageID: "m1", userID: "u1", emoji: ["👍"] });
  s = reducer(s, {
    kind: "message_deleted",
    channelID: "chan-1",
    messageID: "m1",
    deletedAt: new Date(2000),
  });
  assert.equal("m1" in s.reactions, false, "server scrubs them; client must too");
});

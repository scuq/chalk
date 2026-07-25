// Phase 37-3: the message_edited reducer case.
//
// The properties that matter: an edit swaps the body WITHOUT moving the
// message (seq/ts untouched, so no re-sort and no unread churn), it reaches
// the thread cache as well as the channel feed, it refreshes a thread head's
// cached preview when the edited reply is the newest one, and it loses to a
// tombstone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import { initialState, type Message, type AppState } from "./types.ts";

function baseState(): AppState {
  return { ...initialState, messages: {}, threadMessages: {} };
}

function msg(over: Partial<Message>): Message {
  return {
    id: "srv-id",
    channelID: "chan-1",
    seq: 1,
    sender: "dev-1",
    senderUserID: "user-1",
    ts: new Date(1000),
    body: "helo",
    ...over,
  };
}

const EDITED = new Date(5000);

test("edit swaps the body in place and stamps editedAt", () => {
  let s = baseState();
  s = reducer(s, { kind: "message", message: msg({ id: "m1" }) });
  s = reducer(s, {
    kind: "message_edited",
    channelID: "chan-1",
    messageID: "m1",
    body: "hello",
    keyVersion: 2,
    editedAt: EDITED,
  });

  const row = s.messages["chan-1"]![0]!;
  assert.equal(row.body, "hello");
  assert.equal(row.keyVersion, 2);
  assert.deepEqual(row.editedAt, EDITED);
});

test("edit does not move the message or disturb its neighbours", () => {
  let s = baseState();
  s = reducer(s, { kind: "message", message: msg({ id: "m1", seq: 1 }) });
  s = reducer(s, { kind: "message", message: msg({ id: "m2", seq: 2 }) });
  s = reducer(s, { kind: "message", message: msg({ id: "m3", seq: 3 }) });

  const tsBefore = s.messages["chan-1"]![1]!.ts;
  s = reducer(s, {
    kind: "message_edited",
    channelID: "chan-1",
    messageID: "m2",
    body: "fixed",
    editedAt: EDITED,
  });

  const list = s.messages["chan-1"]!;
  assert.deepEqual(list.map((m) => m.id), ["m1", "m2", "m3"], "order preserved");
  assert.equal(list[1]!.seq, 2, "seq untouched");
  assert.deepEqual(list[1]!.ts, tsBefore, "ts untouched");
  assert.equal(list[0]!.body, "helo", "neighbours untouched");
  assert.equal(list[2]!.editedAt, undefined);
});

test("an edit for an unknown id returns the SAME state reference", () => {
  let s = baseState();
  s = reducer(s, { kind: "message", message: msg({ id: "m1" }) });
  const before = s;
  const after = reducer(s, {
    kind: "message_edited",
    channelID: "chan-1",
    messageID: "does-not-exist",
    body: "x",
    editedAt: EDITED,
  });
  assert.equal(after.messages, before.messages);
});

test("re-applying the same edit is a no-op in effect", () => {
  let s = baseState();
  s = reducer(s, { kind: "message", message: msg({ id: "m1" }) });
  const edit = {
    kind: "message_edited" as const,
    channelID: "chan-1",
    messageID: "m1",
    body: "hello",
    editedAt: EDITED,
  };
  s = reducer(s, edit);
  const once = s.messages["chan-1"]![0]!;
  s = reducer(s, edit);
  const twice = s.messages["chan-1"]![0]!;
  assert.deepEqual(twice, once);
  assert.equal(s.messages["chan-1"]!.length, 1);
});

test("a tombstoned message is not resurrected by a late edit", () => {
  let s = baseState();
  s = reducer(s, { kind: "message", message: msg({ id: "m1" }) });
  s = reducer(s, {
    kind: "message_deleted",
    channelID: "chan-1",
    messageID: "m1",
    deletedAt: new Date(4000),
  });
  s = reducer(s, {
    kind: "message_edited",
    channelID: "chan-1",
    messageID: "m1",
    body: "sneaky",
    editedAt: EDITED,
  });

  const row = s.messages["chan-1"]![0]!;
  assert.equal(row.deleted, true);
  assert.equal(row.body, "[message deleted]");
  assert.equal(row.editedAt, undefined);
});

test("editing a reply updates the thread cache and the head's preview", () => {
  let s = baseState();
  s = reducer(s, { kind: "message", message: msg({ id: "head", seq: 1 }) });
  s = reducer(s, {
    kind: "message",
    message: msg({ id: "r1", seq: 2, parentID: "head", threadID: "head", body: "frist" }),
  });

  const headBefore = s.messages["chan-1"]!.find((m) => m.id === "head")!;
  assert.equal(headBefore.lastReplyBody, "frist");

  s = reducer(s, {
    kind: "message_edited",
    channelID: "chan-1",
    messageID: "r1",
    body: "first",
    editedAt: EDITED,
  });

  assert.equal(s.threadMessages["head"]![0]!.body, "first", "thread cache updated");
  const head = s.messages["chan-1"]!.find((m) => m.id === "head")!;
  assert.equal(head.lastReplyBody, "first", "head preview refreshed");
  assert.equal(head.replyCount, 1, "reply count unchanged by an edit");
});

test("editing an older reply leaves the head preview on the newest one", () => {
  let s = baseState();
  s = reducer(s, { kind: "message", message: msg({ id: "head", seq: 1 }) });
  s = reducer(s, {
    kind: "message",
    message: msg({ id: "r1", seq: 2, parentID: "head", threadID: "head", body: "older" }),
  });
  s = reducer(s, {
    kind: "message",
    message: msg({ id: "r2", seq: 3, parentID: "head", threadID: "head", body: "newest" }),
  });

  s = reducer(s, {
    kind: "message_edited",
    channelID: "chan-1",
    messageID: "r1",
    body: "older, fixed",
    editedAt: EDITED,
  });

  const head = s.messages["chan-1"]!.find((m) => m.id === "head")!;
  assert.equal(head.lastReplyBody, "newest", "preview still tracks the newest reply");
  assert.equal(head.lastReplySeq, 3);
  assert.equal(s.threadMessages["head"]![0]!.body, "older, fixed");
});

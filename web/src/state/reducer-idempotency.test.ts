// Regression test for the double-message-echo fix.
//
// The bug: optimistic send appends a row with a client-generated UUID; the
// server echo carries a different (server) UUID. The reducer's id-dedup
// therefore misses, and when the echo reaches the sender (per-conn
// echo-suppression misses on reconnect) the message renders twice. The fix
// carries a client_msg_id through the server and echoes it back; the reducer
// matches the echo to the optimistic row by clientMsgID and REPLACES it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import { initialState, type Message, type AppState } from "./types.ts";

function baseState(): AppState {
  return { ...initialState, messages: {} };
}

function msg(over: Partial<Message>): Message {
  return {
    id: "srv-id",
    channelID: "chan-1",
    seq: 1,
    sender: "dev-1",
    senderUserID: "user-1",
    ts: new Date(1000),
    body: "hello",
    ...over,
  };
}

test("optimistic row is REPLACED by the server echo with matching clientMsgID", () => {
  // 1. optimistic append: local UUID as both id and clientMsgID.
  let s = baseState();
  s = reducer(s, {
    kind: "message",
    message: msg({ id: "local-uuid", clientMsgID: "local-uuid", seq: 0 }),
  });
  assert.equal(s.messages["chan-1"].length, 1);

  // 2. server echo: DIFFERENT id, SAME clientMsgID, real seq/ts.
  s = reducer(s, {
    kind: "message",
    message: msg({
      id: "server-uuid",
      clientMsgID: "local-uuid",
      seq: 42,
      ts: new Date(2000),
    }),
  });

  // Must still be ONE message (replaced, not appended), now with server id/seq.
  assert.equal(s.messages["chan-1"].length, 1, "should not duplicate");
  assert.equal(s.messages["chan-1"][0].id, "server-uuid");
  assert.equal(s.messages["chan-1"][0].seq, 42);
});

test("id-dedup still applies when the same server id arrives twice", () => {
  let s = baseState();
  const m = msg({ id: "server-uuid", seq: 5 });
  s = reducer(s, { kind: "message", message: m });
  s = reducer(s, { kind: "message", message: { ...m } });
  assert.equal(s.messages["chan-1"].length, 1, "same id must dedup");
});

test("messages without clientMsgID append normally (other senders)", () => {
  let s = baseState();
  s = reducer(s, { kind: "message", message: msg({ id: "a", seq: 1 }) });
  s = reducer(s, { kind: "message", message: msg({ id: "b", seq: 2 }) });
  assert.equal(s.messages["chan-1"].length, 2);
});

test("a different clientMsgID does not replace an unrelated optimistic row", () => {
  let s = baseState();
  s = reducer(s, {
    kind: "message",
    message: msg({ id: "opt-1", clientMsgID: "cid-1", seq: 0 }),
  });
  s = reducer(s, {
    kind: "message",
    message: msg({ id: "srv-2", clientMsgID: "cid-2", seq: 1, body: "other" }),
  });
  // No match -> append; two rows.
  assert.equal(s.messages["chan-1"].length, 2);
});

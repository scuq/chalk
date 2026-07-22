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

// ---- send_ack (deterministic optimistic-row retirement) ----
//
// The real-world bug these cover: chalkd suppresses the live echo for the
// sender's own conn, so case "message" reconciliation never fires for our own
// send. The Phase 23g backstop then re-fetches history on channel switch, and
// history rows carry no client_msg_id -- so the server row merged in ALONGSIDE
// the optimistic row. The ack retires the optimistic row either way.

test("send_ack upgrades the optimistic row to the server identity", () => {
  let s = baseState();
  s = reducer(s, {
    kind: "message",
    message: msg({ id: "local-x", clientMsgID: "local-x", seq: 0 }),
  });
  s = reducer(s, {
    kind: "send_ack",
    channelID: "chan-1",
    clientMsgID: "local-x",
    id: "server-x",
    seq: 7,
    ts: new Date(5000),
  });
  const list = s.messages["chan-1"];
  assert.equal(list.length, 1, "still one row");
  assert.equal(list[0].id, "server-x", "adopted server id");
  assert.equal(list[0].seq, 7);
});

test("send_ack DROPS the optimistic row when the server row already arrived (history re-fetch)", () => {
  let s = baseState();
  // optimistic row from our send
  s = reducer(s, {
    kind: "message",
    message: msg({ id: "local-y", clientMsgID: "local-y", seq: 0 }),
  });
  // history re-fetch brings the server copy in (no clientMsgID on history rows)
  s = reducer(s, {
    kind: "history_loaded",
    channelID: "chan-1",
    messages: [msg({ id: "server-y", seq: 9 })],
  });
  assert.equal(s.messages["chan-1"].length, 2, "duplicate exists pre-ack");
  // the ack retires the optimistic row
  s = reducer(s, {
    kind: "send_ack",
    channelID: "chan-1",
    clientMsgID: "local-y",
    id: "server-y",
    seq: 9,
    ts: new Date(9000),
  });
  const list = s.messages["chan-1"];
  assert.equal(list.length, 1, "duplicate resolved");
  assert.equal(list[0].id, "server-y");
});

test("send_ack for an unknown clientMsgID is a no-op", () => {
  let s = baseState();
  s = reducer(s, { kind: "message", message: msg({ id: "a", seq: 1 }) });
  const before = s.messages["chan-1"];
  s = reducer(s, {
    kind: "send_ack",
    channelID: "chan-1",
    clientMsgID: "nope",
    id: "zzz",
    seq: 99,
    ts: new Date(1),
  });
  assert.deepEqual(s.messages["chan-1"], before);
});

test("send_ack also reconciles the optimistic row inside a thread reply list", () => {
  let s = baseState();
  s = reducer(s, {
    kind: "message",
    message: msg({
      id: "local-r",
      clientMsgID: "local-r",
      seq: 0,
      parentID: "root-1",
      threadID: "root-1",
    }),
  });
  assert.equal(s.threadMessages["root-1"].length, 1);
  s = reducer(s, {
    kind: "send_ack",
    channelID: "chan-1",
    clientMsgID: "local-r",
    id: "server-r",
    seq: 4,
    ts: new Date(4000),
  });
  assert.equal(s.threadMessages["root-1"][0].id, "server-r", "thread copy upgraded");
  assert.equal(s.messages["chan-1"][0].id, "server-r", "channel copy upgraded");
});

// 55-1: the historyComplete flag. The properties that matter:
//   * a short page raises it; it is sticky (raise-only) after that
//   * a later full page -- the key-ready backstop refetches the newest 50
//     on every channel switch -- must not clear it
//   * channels are independent
//   * an action without the flag leaves state.historyComplete's identity
//     alone, so memoized renders skip

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import { initialState, type AppState, type Message } from "./types.ts";

const CH = "chan-1";

function baseState(): AppState {
  return { ...initialState, user: { id: "user-me", device: "dev-me", handle: "me" } };
}

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "msg-1",
    channelID: CH,
    seq: 1,
    sender: "dev-them",
    senderUserID: "user-them",
    ts: new Date(1000),
    body: "hi",
    ...over,
  };
}

test("complete=true raises the flag", () => {
  const s = reducer(baseState(), {
    kind: "history_loaded",
    channelID: CH,
    messages: [msg()],
    complete: true,
  });
  assert.equal(s.historyComplete[CH], true);
  assert.equal(s.historyLoaded[CH], true);
});

test("a later page without the flag cannot clear it", () => {
  let s = reducer(baseState(), {
    kind: "history_loaded",
    channelID: CH,
    messages: [msg()],
    complete: true,
  });
  s = reducer(s, {
    kind: "history_loaded",
    channelID: CH,
    messages: [msg({ id: "msg-2", seq: 2 })],
  });
  assert.equal(s.historyComplete[CH], true);
});

test("channels are independent", () => {
  const s = reducer(baseState(), {
    kind: "history_loaded",
    channelID: CH,
    messages: [msg()],
    complete: true,
  });
  assert.equal(s.historyComplete["chan-other"], undefined);
});

test("an action without the flag keeps the map's identity", () => {
  const base = baseState();
  const s = reducer(base, {
    kind: "history_loaded",
    channelID: CH,
    messages: [msg()],
  });
  assert.equal(s.historyComplete, base.historyComplete);
});

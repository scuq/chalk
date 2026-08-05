// Phase 42: thread read state in the reducer.
//
// Before 42 this was a localStorage blob rewritten in full on every arriving
// reply, so none of it had reducer coverage. The properties that matter:
//   * history rows carry the viewer's own thread cursor, and it hydrates
//   * hydration only moves a cursor forward -- a local bump already ahead of
//     what the server knew must survive a history refetch
//   * a reply row never hydrates a cursor (only thread heads have one)
//   * unchanged state keeps its object identity, so memoized renders skip

import { test } from "node:test";
import assert from "node:assert/strict";
import { reducer } from "./reducer.ts";
import {
  initialState,
  type AppState,
  type Message,
  type ThreadInboxRow,
} from "./types.ts";

const ME = "user-me";
const THEM = "user-them";
const CH = "chan-1";
const HEAD = "msg-head";

function baseState(): AppState {
  return {
    ...initialState,
    messages: {},
    threadSeen: {},
    user: { id: ME, device: "dev-me", handle: "me" },
  };
}

function msg(over: Partial<Message> = {}): Message {
  return {
    id: HEAD,
    channelID: CH,
    seq: 1,
    sender: "dev-them",
    senderUserID: THEM,
    ts: new Date(1000),
    body: "hi",
    ...over,
  };
}

// ---- 42-3: cursors ride in with history ---------------------------------

test("a history row's thread cursor hydrates threadSeen", () => {
  const s = reducer(baseState(), {
    kind: "history_loaded",
    channelID: CH,
    messages: [msg({ replyCount: 3, lastReplySeq: 9, threadLastReadSeq: 7 })],
  });
  assert.equal(s.threadSeen[HEAD], 7);
});

test("hydration cannot rewind a cursor a local bump already advanced", () => {
  let s = baseState();
  s = { ...s, threadSeen: { [HEAD]: 9 } };
  s = reducer(s, {
    kind: "history_loaded",
    channelID: CH,
    messages: [msg({ lastReplySeq: 9, threadLastReadSeq: 4 })],
  });
  assert.equal(s.threadSeen[HEAD], 9, "a stale page rewound the cursor");
});

test("a reply row does not hydrate a thread cursor", () => {
  // Only heads carry thread state; a reply's threadLastReadSeq would be about
  // some other thread entirely, so keying threadSeen by the reply's id would
  // invent a thread that does not exist.
  const s = reducer(baseState(), {
    kind: "history_loaded",
    channelID: CH,
    messages: [msg({ id: "msg-reply", parentID: HEAD, threadLastReadSeq: 5 })],
  });
  assert.deepEqual(s.threadSeen, {});
});

test("history with no thread cursors keeps threadSeen's identity", () => {
  const before = baseState();
  const s = reducer(before, {
    kind: "history_loaded",
    channelID: CH,
    messages: [msg()],
  });
  assert.equal(s.threadSeen, before.threadSeen, "threadSeen was needlessly copied");
});

// ---- 42-4: the durable cursor, live -------------------------------------

test("thread_read_state advances the cursor", () => {
  const s = reducer(baseState(), {
    kind: "thread_read_state",
    threadID: HEAD,
    lastReadSeq: 12,
  });
  assert.equal(s.threadSeen[HEAD], 12);
});

test("a stale thread_read_state cannot rewind the cursor", () => {
  let s = baseState();
  s = reducer(s, { kind: "thread_read_state", threadID: HEAD, lastReadSeq: 12 });
  s = reducer(s, { kind: "thread_read_state", threadID: HEAD, lastReadSeq: 4 });
  assert.equal(s.threadSeen[HEAD], 12);
});

test("a thread_read_state we're already at keeps state identity", () => {
  // The push lands on every device including ones already caught up. A fresh
  // object there would re-render the feed for nothing.
  let s = reducer(baseState(), {
    kind: "thread_read_state",
    threadID: HEAD,
    lastReadSeq: 12,
  });
  const before = s;
  s = reducer(s, { kind: "thread_read_state", threadID: HEAD, lastReadSeq: 12 });
  assert.equal(s, before, "a redundant push produced a new state object");
});

test("reading one thread does not touch another's cursor", () => {
  let s = reducer(baseState(), {
    kind: "thread_read_state",
    threadID: HEAD,
    lastReadSeq: 5,
  });
  s = reducer(s, { kind: "thread_read_state", threadID: "other", lastReadSeq: 3 });
  assert.equal(s.threadSeen[HEAD], 5);
  assert.equal(s.threadSeen["other"], 3);
});

test("an older server that omits the cursor hydrates nothing", () => {
  // thread_last_read_seq is omitempty on the wire, so 0 arrives as undefined.
  // That must read as "no information", not as "read up to 0".
  let s = baseState();
  s = { ...s, threadSeen: { [HEAD]: 6 } };
  s = reducer(s, {
    kind: "history_loaded",
    channelID: CH,
    messages: [msg({ lastReplySeq: 9 })],
  });
  assert.equal(s.threadSeen[HEAD], 6);
});

// ---- 42-7: the inbox -----------------------------------------------------

function inboxRow(over: Partial<ThreadInboxRow> = {}): ThreadInboxRow {
  return {
    channelID: CH,
    threadID: HEAD,
    headSeq: 1,
    headTS: new Date(1000),
    lastReplySeq: 5,
    lastReplyTS: new Date(2000),
    replyCount: 1,
    lastReadSeq: 0,
    involved: true,
    ...over,
  };
}

function loaded(over: Partial<AppState> = {}): AppState {
  return {
    ...baseState(),
    threadInboxActive: [inboxRow()],
    threadInboxLoaded: true,
    ...over,
  };
}

test("a live reply to a known thread moves it to the front and bumps the count", () => {
  const s = reducer(
    loaded({
      threadInboxActive: [
        inboxRow({ threadID: "other", lastReplySeq: 9 }),
        inboxRow({ threadID: HEAD, lastReplySeq: 5, replyCount: 2 }),
      ],
    }),
    { kind: "message", message: msg({ id: "r1", seq: 11, parentID: HEAD, threadID: HEAD }) },
  );
  assert.equal(s.threadInboxActive[0].threadID, HEAD, "the freshest thread is not first");
  assert.equal(s.threadInboxActive[0].lastReplySeq, 11);
  assert.equal(s.threadInboxActive[0].replyCount, 3);
  assert.equal(s.threadInboxActive.length, 2, "the list grew or shrank");
  assert.equal(s.threadInboxStale, false, "a known thread should not force a refetch");
});

test("an out-of-order reply cannot rewind the newest-reply pointers", () => {
  const s = reducer(
    loaded({ threadInboxActive: [inboxRow({ lastReplySeq: 20, replyCount: 4 })] }),
    { kind: "message", message: msg({ id: "r1", seq: 7, parentID: HEAD, threadID: HEAD }) },
  );
  assert.equal(s.threadInboxActive[0].lastReplySeq, 20);
  assert.equal(s.threadInboxActive[0].replyCount, 4);
});

test("a live reply to an unknown thread flags a refetch and inserts nothing", () => {
  // The client cannot know `involved` for a thread it holds no row for, and
  // guessing would either invent urgency or hide it. Only the server knows.
  const s = reducer(loaded(), {
    kind: "message",
    message: msg({ id: "r1", seq: 3, parentID: "unknown-head", threadID: "unknown-head" }),
  });
  assert.equal(s.threadInboxActive.length, 1);
  assert.equal(s.threadInboxStale, true);
});

test("a live reply before the inbox has ever loaded does not flag it stale", () => {
  const s = reducer(baseState(), {
    kind: "message",
    message: msg({ id: "r1", seq: 3, parentID: "some-head", threadID: "some-head" }),
  });
  assert.equal(s.threadInboxStale, false);
});

test("thread_inbox_loaded replaces both halves and clears staleness", () => {
  const s = reducer(loaded({ threadInboxStale: true }), {
    kind: "thread_inbox_loaded",
    active: [inboxRow({ threadID: "a" })],
    agedUnread: [inboxRow({ threadID: "b" })],
    unreadTotal: 7,
    hasMoreActive: true,
    windowHours: 72,
    append: false,
  });
  assert.deepEqual(s.threadInboxActive.map((r) => r.threadID), ["a"]);
  assert.deepEqual(s.threadInboxAgedUnread.map((r) => r.threadID), ["b"]);
  assert.equal(s.threadInboxUnreadTotal, 7);
  assert.equal(s.threadInboxHasMoreActive, true);
  assert.equal(s.threadInboxWindowHours, 72);
  assert.equal(s.threadInboxStale, false);
});

test("appending a page keeps the aged half untouched and dedupes the active half", () => {
  // "load more" pages the active list only; the aged list is first-page-only,
  // so a later page must not blank it.
  const s = reducer(
    loaded({
      threadInboxActive: [inboxRow({ threadID: "a" })],
      threadInboxAgedUnread: [inboxRow({ threadID: "keep" })],
    }),
    {
      kind: "thread_inbox_loaded",
      active: [inboxRow({ threadID: "a" }), inboxRow({ threadID: "b" })],
      agedUnread: [],
      unreadTotal: 1,
      hasMoreActive: false,
      windowHours: 48,
      append: true,
    },
  );
  assert.deepEqual(s.threadInboxActive.map((r) => r.threadID), ["a", "b"]);
  assert.deepEqual(s.threadInboxAgedUnread.map((r) => r.threadID), ["keep"]);
});

test("previews fill in place for the named channel only", () => {
  const s = reducer(
    loaded({
      threadInboxActive: [
        inboxRow({ threadID: "mine", channelID: CH }),
        inboxRow({ threadID: "theirs", channelID: "other-channel" }),
      ],
    }),
    {
      kind: "thread_inbox_previews",
      channelID: CH,
      previews: {
        mine: { headBody: "head text", lastReplyBody: "reply text" },
        theirs: { headBody: "must not apply" },
      },
    },
  );
  assert.equal(s.threadInboxActive[0].headBody, "head text");
  assert.equal(s.threadInboxActive[0].lastReplyBody, "reply text");
  assert.equal(s.threadInboxActive[1].headBody, undefined, "another channel's row was filled");
});

test("a preview dispatch that changes nothing keeps state identity", () => {
  // Fires once per channel as keys settle; a fresh array per channel would
  // re-render the whole panel that many times.
  const before = loaded();
  const s = reducer(before, {
    kind: "thread_inbox_previews",
    channelID: "some-other-channel",
    previews: { x: { headBody: "y" } },
  });
  assert.equal(s, before);
});

// A refetch is routine -- opening the panel, reading any thread, a reply to a
// thread we hold no row for -- and the rows it brings back are ciphertext. The
// panel showed every row's skeleton again after each one, and the decrypt pass
// (bounded to once per channel per session) never ran a second time to fill
// them, so the previews stayed gone for the rest of the session.
test("a refetch keeps the previews its rows already decrypted", () => {
  const s = reducer(
    loaded({
      threadInboxActive: [
        inboxRow({ headBody: "the head", lastReplyBody: "the reply" }),
      ],
    }),
    {
      kind: "thread_inbox_loaded",
      active: [inboxRow()],
      agedUnread: [],
      unreadTotal: 1,
      hasMoreActive: false,
      windowHours: 48,
      append: false,
    },
  );
  assert.equal(s.threadInboxActive[0].headBody, "the head");
  assert.equal(s.threadInboxActive[0].lastReplyBody, "the reply");
});

test("a refetch drops a preview the pointer has moved past", () => {
  const s = reducer(
    loaded({
      threadInboxActive: [
        inboxRow({ headBody: "the head", lastReplyBody: "the old reply" }),
      ],
    }),
    {
      kind: "thread_inbox_loaded",
      active: [inboxRow({ lastReplySeq: 6 })],
      agedUnread: [],
      unreadTotal: 1,
      hasMoreActive: false,
      windowHours: 48,
      append: false,
    },
  );
  assert.equal(s.threadInboxActive[0].headBody, "the head", "the head did not move");
  assert.equal(
    s.threadInboxActive[0].lastReplyBody,
    undefined,
    "a newer reply kept the old plaintext",
  );
});

test("the aged half carries its previews across a refetch too", () => {
  const s = reducer(
    loaded({
      threadInboxActive: [],
      threadInboxAgedUnread: [inboxRow({ lastReplyBody: "old but unread" })],
    }),
    {
      kind: "thread_inbox_loaded",
      active: [],
      agedUnread: [inboxRow()],
      unreadTotal: 1,
      hasMoreActive: false,
      windowHours: 48,
      append: false,
    },
  );
  assert.equal(s.threadInboxAgedUnread[0].lastReplyBody, "old but unread");
});

test("open_thread_from_inbox switches channel AND leaves the thread open", () => {
  // The regression this action exists to prevent: set_active_channel nulls
  // openThread, so doing this in two dispatches works only by ordering luck.
  const s = reducer(baseState(), {
    kind: "open_thread_from_inbox",
    channelID: "chan-2",
    threadID: "thread-9",
  });
  assert.equal(s.activeChannelID, "chan-2");
  assert.equal(s.openThread?.threadID, "thread-9");
  assert.equal(s.openThread?.channelID, "chan-2");
});

test("thread_mention_set is idempotent", () => {
  let s = reducer(baseState(), { kind: "thread_mention_set", threadID: HEAD });
  assert.equal(s.threadMentions[HEAD], true);
  const before = s;
  s = reducer(s, { kind: "thread_mention_set", threadID: HEAD });
  assert.equal(s, before);
});

// ---- 42-10: a refetch is additive ---------------------------------------
//
// The panel now re-sends fetch_thread on every open, on reconnect and on
// returning to the tab, so a second ack for a thread that already has replies
// is the normal case rather than a race. These pin the properties that make
// that safe -- if thread_loaded ever went back to replacing, the refetch would
// turn a dropped reply into a lost one.

function reply(over: Partial<Message> = {}): Message {
  return msg({
    id: "reply-1",
    seq: 2,
    parentID: HEAD,
    threadID: HEAD,
    body: "first",
    ...over,
  });
}

test("a second thread_loaded keeps replies the first one delivered", () => {
  // The server caps a thread page at 50 rows, so a refetch of a long thread
  // answers with the NEWEST replies -- the older ones are absent from the ack,
  // not deleted.
  let s = reducer(baseState(), {
    kind: "thread_loaded",
    threadID: HEAD,
    messages: [reply({ id: "old", seq: 2 }), reply({ id: "mid", seq: 3 })],
  });
  s = reducer(s, {
    kind: "thread_loaded",
    threadID: HEAD,
    messages: [reply({ id: "mid", seq: 3 }), reply({ id: "new", seq: 4 })],
  });
  assert.deepEqual(
    s.threadMessages[HEAD].map((m) => m.id),
    ["old", "mid", "new"],
    "the refetch dropped replies it did not carry",
  );
});

test("a refetch never empties the panel or clears its loaded flag", () => {
  // This is the "no loading flash" property: ThreadPanel renders "loading
  // replies…" on !loaded and the empty state on zero replies, so a refetch
  // that cleared either would blank a thread the user is reading.
  let s = reducer(baseState(), {
    kind: "thread_loaded",
    threadID: HEAD,
    messages: [reply()],
  });
  s = reducer(s, { kind: "thread_loaded", threadID: HEAD, messages: [reply()] });
  assert.equal(s.threadLoaded[HEAD], true);
  assert.equal(s.threadMessages[HEAD].length, 1);
});

test("the refetched row wins on an id collision, and order holds", () => {
  // An edit or a delete that landed while this client was away arrives as the
  // same id with a different body; the server's copy is the current one.
  let s = reducer(baseState(), {
    kind: "thread_loaded",
    threadID: HEAD,
    messages: [reply({ id: "a", seq: 3, body: "before" })],
  });
  s = reducer(s, {
    kind: "thread_loaded",
    threadID: HEAD,
    messages: [
      reply({ id: "b", seq: 2, body: "older" }),
      reply({ id: "a", seq: 3, body: "after" }),
    ],
  });
  assert.deepEqual(
    s.threadMessages[HEAD].map((m) => [m.id, m.body]),
    [
      ["b", "older"],
      ["a", "after"],
    ],
  );
});

test("refetching one thread leaves another's replies alone", () => {
  let s = reducer(baseState(), {
    kind: "thread_loaded",
    threadID: "other",
    messages: [reply({ id: "other-1", threadID: "other", parentID: "other" })],
  });
  s = reducer(s, { kind: "thread_loaded", threadID: HEAD, messages: [reply()] });
  assert.deepEqual(
    s.threadMessages["other"].map((m) => m.id),
    ["other-1"],
  );
  assert.equal(s.threadLoaded["other"], true);
});

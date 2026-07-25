import { test } from "node:test";
import assert from "node:assert/strict";
import { canEditMessage, lastEditableMessage, EDIT_WINDOW_MS } from "./editpolicy";

const ME = "user-me";
const PEER = "user-peer";
const NOW = 1_800_000_000_000;

function msg(over: Partial<Parameters<typeof canEditMessage>[0] & object> = {}) {
  return {
    senderUserID: ME,
    ts: new Date(NOW - 1000),
    seq: 7,
    ...over,
  };
}

test("your own recent message is editable", () => {
  assert.equal(canEditMessage(msg(), ME, NOW), true);
});

test("someone else's message is never editable, however recent", () => {
  assert.equal(canEditMessage(msg({ senderUserID: PEER }), ME, NOW), false);
  // A purged sender is nobody's "own" either.
  assert.equal(canEditMessage(msg({ senderUserID: "" }), ME, NOW), false);
});

test("the window is exclusive at its edge", () => {
  const atEdge = msg({ ts: new Date(NOW - EDIT_WINDOW_MS) });
  assert.equal(canEditMessage(atEdge, ME, NOW), false);
  const justInside = msg({ ts: new Date(NOW - EDIT_WINDOW_MS + 1) });
  assert.equal(canEditMessage(justInside, ME, NOW), true);
});

test("a deleted message is not editable -- the scrub is final", () => {
  assert.equal(canEditMessage(msg({ deleted: true }), ME, NOW), false);
});

test("an unacked optimistic row is not editable", () => {
  // clientMsgID set + no server seq yet: the server has never heard of this id.
  assert.equal(canEditMessage(msg({ clientMsgID: "local-1", seq: 0 }), ME, NOW), false);
  // Once the ack lands it carries a real seq and becomes editable.
  assert.equal(canEditMessage(msg({ clientMsgID: "local-1", seq: 12 }), ME, NOW), true);
});

test("no message or no session, no edit", () => {
  assert.equal(canEditMessage(null, ME, NOW), false);
  assert.equal(canEditMessage(msg(), null, NOW), false);
});

test("cursor-up targets your most recent editable message", () => {
  const list = [
    msg({ seq: 1, ts: new Date(NOW - 5000) }),
    msg({ seq: 2, senderUserID: PEER, ts: new Date(NOW - 4000) }),
    msg({ seq: 3, ts: new Date(NOW - 3000) }),
    msg({ seq: 4, senderUserID: PEER, ts: new Date(NOW - 2000) }),
  ];
  assert.equal(lastEditableMessage(list, ME, NOW)?.seq, 3);
});

test("cursor-up skips your own deleted and out-of-window messages", () => {
  const list = [
    msg({ seq: 1, ts: new Date(NOW - 1000) }),
    msg({ seq: 2, ts: new Date(NOW - 1000), deleted: true }),
  ];
  assert.equal(lastEditableMessage(list, ME, NOW)?.seq, 1);

  const allStale = [msg({ seq: 1, ts: new Date(NOW - EDIT_WINDOW_MS - 1) })];
  assert.equal(lastEditableMessage(allStale, ME, NOW), null);
});

test("cursor-up on an empty or foreign list finds nothing", () => {
  assert.equal(lastEditableMessage([], ME, NOW), null);
  assert.equal(lastEditableMessage([msg({ senderUserID: PEER })], ME, NOW), null);
  assert.equal(lastEditableMessage([msg()], null, NOW), null);
});

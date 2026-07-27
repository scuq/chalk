// One arriving message, at most one sound.
//
// The case that matters most is the first one: a sound for a message you
// typed yourself is the most obviously broken thing this feature could
// do, and it is not hypothetical -- your own message comes back to you on
// your other devices and after any reconnect.

import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryForMessage, type MessageFacts, type Surroundings } from "./classify.ts";
import { mentionsHandle } from "../chat/mentions.ts";

const ME = { id: "u-me", handle: "scuq" };
const THEM = "u-them";

function msg(over: Partial<MessageFacts> = {}): MessageFacts {
  return { senderUserID: THEM, body: "hello", ...over };
}

function where(over: Partial<Surroundings> = {}): Surroundings {
  return { isDM: false, threadInvolvesViewer: false, ...over };
}

const call = (m: MessageFacts, w = where()) => categoryForMessage(m, ME, w, mentionsHandle);

test("your own message never makes a sound", () => {
  const mine = msg({ senderUserID: ME.id });
  assert.equal(call(mine), null);
  // Not even when it would otherwise be the loudest category available.
  assert.equal(call({ ...mine, body: "@scuq" }, where({ isDM: true })), null);
  assert.equal(call({ ...mine, parentID: "p1" }, where({ threadInvolvesViewer: true })), null);
});

test("a plain message in a channel is the quiet one", () => {
  assert.equal(call(msg()), "message");
});

test("being named raises it to a mention", () => {
  assert.equal(call(msg({ body: "hey @scuq look at this" })), "mention");
});

test("someone else's handle is not your mention", () => {
  assert.equal(call(msg({ body: "hey @someoneelse" })), "message");
});

test("a DM outranks a mention", () => {
  // In a 1:1 the channel already tells you the message is for you, so the
  // DM sound is the more informative of the two.
  assert.equal(call(msg({ body: "@scuq hi" }), where({ isDM: true })), "dm");
  assert.equal(call(msg(), where({ isDM: true })), "dm");
});

test("a thread reply inside a DM is still a DM", () => {
  // The notification taxonomy counts everything in a 1:1 as dm, thread
  // replies included -- this pins the precedence that makes it so.
  const reply = msg({ parentID: "p1" });
  assert.equal(call(reply, where({ isDM: true, threadInvolvesViewer: true })), "dm");
  assert.equal(call(reply, where({ isDM: true, threadInvolvesViewer: false })), "dm");
});

test("a reply only counts as a thread reply if you're in the thread", () => {
  const reply = msg({ parentID: "p1" });
  assert.equal(call(reply, where({ threadInvolvesViewer: true })), "thread_reply");
  assert.equal(
    call(reply, where({ threadInvolvesViewer: false })),
    "message",
    "a thread you never touched is just another message",
  );
});

test("a mention inside a thread reply still reads as a mention", () => {
  const reply = msg({ parentID: "p1", body: "what do you think @scuq" });
  assert.equal(call(reply, where({ threadInvolvesViewer: true })), "mention");
});

test("a viewer with no handle yet cannot be mentioned", () => {
  // The welcome frame populates the handle; a message arriving in that
  // window must not crash or match everything.
  const anon = { id: "u-me", handle: "" };
  assert.equal(categoryForMessage(msg({ body: "@scuq" }), anon, where(), mentionsHandle), "message");
});

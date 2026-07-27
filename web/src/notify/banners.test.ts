// Banner content: what each event type says, and which tag it collapses
// under. The tag scheme is load-bearing twice over -- it is both the
// collapse key (one banner per channel, however busy) and the teardown
// key (reading the channel closes exactly its banners) -- so it is
// pinned here per type.

import { test } from "node:test";
import assert from "node:assert/strict";
import { bannerContent } from "./banners.ts";
import type { NotifyEvent } from "./bus.ts";

const ev = (over: Partial<NotifyEvent> & Pick<NotifyEvent, "type">): NotifyEvent => ({
  senderUserID: "u1",
  channelID: "c1",
  senderHandle: "alice",
  channelName: "general",
  ...over,
});

test("a dm banner is titled by the sender and carries the preview", () => {
  const c = bannerContent(ev({ type: "dm", isDM: true, preview: "hi there" }));
  assert.equal(c.title, "alice");
  assert.equal(c.body, "hi there");
  assert.equal(c.tag, "chalk-ch-c1");
});

test("mention and message share the channel tag, differ in title", () => {
  const mention = bannerContent(ev({ type: "mention", preview: "hey @scuq" }));
  const message = bannerContent(ev({ type: "message", preview: "hello" }));
  assert.equal(mention.title, "alice mentioned you in #general");
  assert.equal(message.title, "alice in #general");
  assert.equal(mention.tag, message.tag, "one banner per channel, whoever spoke last");
});

test("a thread reply collapses per thread, not per channel", () => {
  const c = bannerContent(ev({ type: "thread_reply", threadID: "t9", preview: "re: that" }));
  assert.equal(c.tag, "chalk-th-t9");
  assert.equal(c.title, "alice in a thread in #general");
});

test("a call banner names the room and the joiner", () => {
  const c = bannerContent(ev({ type: "voice", channelName: "standup" }));
  assert.equal(c.title, "#standup — call started");
  assert.equal(c.body, "alice joined");
  assert.equal(c.tag, "chalk-voice-c1");
});

test("event banners: channel_added, friend_request, governance", () => {
  assert.equal(bannerContent(ev({ type: "channel_added" })).title, "added to #general");
  const fr = bannerContent(ev({ type: "friend_request", channelID: undefined }));
  assert.equal(fr.title, "friend request from alice");
  assert.equal(fr.tag, "chalk-friend", "all requests share one tag; the panel lists the rest");
  const gov = bannerContent(ev({ type: "governance", preview: "a proposal opened" }));
  assert.equal(gov.title, "#general — a proposal opened");
  assert.equal(gov.tag, "chalk-gov-c1");
});

test("missing facts degrade to words, never to undefined-in-a-string", () => {
  const c = bannerContent(
    ev({ type: "message", senderHandle: undefined, channelName: undefined, preview: undefined }),
  );
  assert.equal(c.title, "someone in a channel");
  assert.equal(c.body, "");
  const v = bannerContent(ev({ type: "voice", senderHandle: undefined }));
  assert.equal(v.body, "", "no joiner handle means no body, not 'undefined joined'");
});

test("previews truncate at a bounded length", () => {
  const long = "x".repeat(500);
  const c = bannerContent(ev({ type: "dm", preview: long }));
  assert.ok(c.body.length <= 140);
  assert.ok(c.body.endsWith("…"));
});

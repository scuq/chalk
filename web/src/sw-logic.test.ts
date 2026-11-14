import { test } from "node:test";
import assert from "node:assert/strict";
import { clickTarget, notificationFor, parsePushPayload, urlBase64ToBytes } from "./sw-logic";

const base = {
  v: 1,
  kind: "message",
  channel_id: "c1",
  message_id: "m1",
  sender_handle: "alice",
  channel_name: "general",
  is_dm: false,
  unread: 3,
};

test("a channel message names the sender and the channel", () => {
  const n = notificationFor(parsePushPayload(base), "/icons/icon-192-AB.png");
  assert.equal(n.title, "@alice in #general");
  assert.equal(n.options.body, "New message");
  assert.equal(n.options.tag, "chalk-ch-c1");
  assert.equal(n.options.icon, "/icons/icon-192-AB.png");
  assert.deepEqual(n.options.data, { channelID: "c1", threadID: undefined });
  assert.equal(n.badge, 3);
});

test("a DM names only the sender", () => {
  const n = notificationFor(parsePushPayload({ ...base, is_dm: true, channel_name: undefined }));
  assert.equal(n.title, "@alice");
});

test("a thread reply has the thread tag and target", () => {
  const n = notificationFor(parsePushPayload({ ...base, thread_id: "t1" }));
  assert.equal(n.options.tag, "chalk-th-t1");
  assert.equal(n.options.body, "New reply in a thread");
  assert.deepEqual(clickTarget(n.options.data), { channelID: "c1", threadID: "t1" });
});

test("a bad payload still gives a notification, and leaves the badge", () => {
  for (const bad of [null, "x", 5, {}, { ...base, v: 2 }, { ...base, kind: "reaction" }, { ...base, channel_id: 7 }]) {
    const p = parsePushPayload(bad);
    assert.equal(p, null);
    const n = notificationFor(p);
    assert.equal(n.title, "chalk");
    assert.equal(n.badge, null);
    assert.deepEqual(clickTarget(n.options.data), {});
  }
});

test("payload fields are sanitized", () => {
  const p = parsePushPayload({ ...base, unread: -4.5, sender_handle: 9, thread_id: "" });
  assert.ok(p);
  assert.equal(p.unread, 0);
  assert.equal(p.sender_handle, "");
  assert.equal(p.thread_id, undefined);
  assert.equal(notificationFor(p).title, "someone in #general");
  assert.equal(parsePushPayload({ ...base, unread: Infinity })?.unread, 0);
});

test("a click target needs a channel before it takes a thread", () => {
  assert.deepEqual(clickTarget({ threadID: "t1" }), {});
  assert.deepEqual(clickTarget(undefined), {});
  assert.deepEqual(clickTarget({ channelID: "c1" }), { channelID: "c1" });
});

test("a base64url key decodes to its bytes", () => {
  const bytes = new Uint8Array([4, 255, 0, 62, 63, 250]);
  const b64url = Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  assert.deepEqual(urlBase64ToBytes(b64url), bytes);
});

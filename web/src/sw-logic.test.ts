import { test } from "node:test";
import assert from "node:assert/strict";
import { clickTarget, notificationFor, openURL, parseOpenURL, parsePushPayload, urlBase64ToBytes } from "./sw-logic";

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

test("a closed app opens at a URL that names the chat, and the page reads it back", () => {
  const ch = "9c370234-2af9-451c-8a9b-f9bbe5c4c8cc";
  assert.equal(openURL({}), "/");
  assert.equal(openURL({ channelID: ch }), `/?open=${ch}`);
  assert.equal(openURL({ channelID: ch, threadID: "t1" }), `/?open=${ch}&thread=t1`);
  assert.deepEqual(parseOpenURL(openURL({ channelID: ch, threadID: "t1" }).slice(1)), { channelID: ch, threadID: "t1" });
  assert.deepEqual(parseOpenURL(`?open=${ch}`), { channelID: ch });
});

test("an open URL takes only plain ids", () => {
  assert.equal(openURL({ channelID: "../x" }), "/");
  assert.equal(openURL({ channelID: "c1", threadID: "a b" }), "/?open=c1");
  assert.equal(parseOpenURL(""), null);
  assert.equal(parseOpenURL("?open="), null);
  assert.equal(parseOpenURL("?open=%3Cscript%3E"), null);
  assert.equal(parseOpenURL("?open=" + "a".repeat(65)), null);
  assert.deepEqual(parseOpenURL("?open=c1&thread=a%20b"), { channelID: "c1" });
});

// 87-8: the reminder push.
const REM = "5b0f7c1e-52f0-4a8e-9d3a-0c9a4f1d2e77";

test("a reminder push shows one constant line and no message data", () => {
  const p = parsePushPayload({ v: 1, kind: "reminder", reminder_id: REM });
  assert.deepEqual(p, { v: 1, kind: "reminder", reminder_id: REM });
  const n = notificationFor(p, "/icons/icon-192-AB.png");
  assert.equal(n.title, "chalk");
  assert.equal(n.options.body, "Reminder: a message is due");
  assert.equal(n.options.tag, `chalk-rem-${REM}`, "the tag of the in-app reminder banner");
  assert.deepEqual(n.options.data, { reminderID: REM });
  assert.equal(n.badge, null, "a reminder does not change the app badge");
});

test("a reminder push with a bad ID gets the generic notification", () => {
  assert.equal(parsePushPayload({ v: 1, kind: "reminder" }), null);
  assert.equal(parsePushPayload({ v: 1, kind: "reminder", reminder_id: "a b" }), null);
  assert.equal(parsePushPayload({ v: 2, kind: "reminder", reminder_id: REM }), null);
  assert.equal(notificationFor(null).options.tag, "chalk-push");
});

test("a reminder click target stands alone and goes through the URL", () => {
  assert.deepEqual(clickTarget({ reminderID: REM }), { reminderID: REM });
  assert.equal(openURL({ reminderID: REM }), `/?reminder=${REM}`);
  assert.deepEqual(parseOpenURL(`?reminder=${REM}`), { reminderID: REM });
  assert.equal(openURL({ reminderID: "../x" }), "/");
  assert.equal(parseOpenURL("?reminder=%3Cscript%3E"), null);
  assert.deepEqual(parseOpenURL("?reminder=a%20b&open=c1"), { channelID: "c1" });
});

// 136-4d: tests of the page side of the iOS push bridge: the reply check, the
// payload, the reconcile plan, and the tap target. The app side is in ios/chalkTests/PushTests.swift.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { PushStatePayload } from "../proto";
import {
  apnsPayload,
  nativeBadgeMessage,
  nativePushBridge,
  openTargetFromIOS,
  parseNativeReply,
  planNativeReconcile,
  type NativeReply,
} from "./ios-push";

const P256DH = "B" + "A".repeat(86);
const AUTH = "A".repeat(22);
const TOKEN = "00fc13adff785122b4ad28809a3420982341241421348097878e577c991de8f0";
const ID = "11111111-1111-1111-1111-111111111111";

const good = { ok: true, token: TOKEN.toUpperCase(), p256dh: P256DH, auth: AUTH, topic: "at.73c.chalk", environment: "production" };

test("the bridge exists only where WebKit gives a reply handler", () => {
  const h = { postMessage: async () => null };
  assert.equal(nativePushBridge({ webkit: { messageHandlers: { chalkPush: h } } }), h);
  assert.equal(nativePushBridge({ webkit: { messageHandlers: { other: h } } }), null);
  assert.equal(nativePushBridge({ webkit: { messageHandlers: { chalkPush: {} } } }), null);
  assert.equal(nativePushBridge({}), null);
  assert.equal(nativePushBridge(undefined), null);
});

test("a good reply from the app becomes a registration", () => {
  const r = parseNativeReply(good);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.reg.token, TOKEN);
  assert.deepEqual(apnsPayload(r.reg, "all"), {
    token: TOKEN, p256dh: P256DH, auth: AUTH, scope: "all", topic: "at.73c.chalk", environment: "production",
  });
});

test("a bad or failed reply is refused", () => {
  assert.deepEqual(parseNativeReply({ ok: false, error: "denied" }), { ok: false, error: "denied" });
  assert.deepEqual(parseNativeReply({ ok: false, error: "whatever" }), { ok: false, error: "unavailable" });
  for (const bad of [
    null, "x", 1, {},
    { ...good, token: "" }, { ...good, token: "zz" }, { ...good, token: "a".repeat(201) },
    { ...good, p256dh: P256DH.slice(1) }, { ...good, p256dh: "%%%" }, { ...good, auth: AUTH + "AA" },
    { ...good, topic: "" }, { ...good, environment: "staging" },
  ]) {
    assert.deepEqual(parseNativeReply(bad), { ok: false, error: "unavailable" }, JSON.stringify(bad));
  }
});

const state = (o: Partial<PushStatePayload> = {}): PushStatePayload => ({
  enabled: true, subscribed: true, key_current: true, kind: "apns", endpoint: TOKEN, scope: "dms",
  apns_topic: "at.73c.chalk", apns_environment: "production", ...o,
});
const ok = parseNativeReply(good) as NativeReply;

test("reconcile keeps the server row in step with the app's token", () => {
  assert.deepEqual(planNativeReconcile(state(), ok), { kind: "upload", scope: "dms" });
  assert.deepEqual(planNativeReconcile(state({ endpoint: "ab12" }), ok), { kind: "upload", scope: "dms" });
  assert.deepEqual(planNativeReconcile(state({ key_current: false, scope: "all" }), ok), { kind: "upload", scope: "all" });
  assert.deepEqual(planNativeReconcile(state(), { ok: false, error: "denied" }), { kind: "drop-server" });
  assert.deepEqual(planNativeReconcile(state(), { ok: false, error: "unavailable" }), { kind: "none" });
  for (const o of [{ subscribed: false }, { kind: "webpush" as const }, { apns_topic: "" }, { enabled: false }]) {
    assert.deepEqual(planNativeReconcile(state(o), ok), { kind: "none" }, JSON.stringify(o));
  }
});

test("a tap from the app opens only ids that look like ids", () => {
  assert.deepEqual(openTargetFromIOS({ channelID: ID }), { channelID: ID });
  assert.deepEqual(openTargetFromIOS({ channelID: ID, threadID: ID }), { channelID: ID, threadID: ID });
  assert.deepEqual(openTargetFromIOS({ reminderID: ID }), { reminderID: ID });
  assert.deepEqual(openTargetFromIOS({ channelID: ID, threadID: "../x" }), { channelID: ID });
  assert.equal(openTargetFromIOS({ channelID: "javascript:x" }), null);
  assert.equal(openTargetFromIOS({ threadID: ID }), null);
  assert.equal(openTargetFromIOS(null), null);
});

test("the badge message to the app carries a whole count from 0 to 9999", () => {
  assert.deepEqual(nativeBadgeMessage(3), { op: "badge", count: 3 });
  assert.deepEqual(nativeBadgeMessage(0), { op: "badge", count: 0 });
  assert.deepEqual(nativeBadgeMessage(-2), { op: "badge", count: 0 });
  assert.deepEqual(nativeBadgeMessage(2.7), { op: "badge", count: 2 });
  assert.deepEqual(nativeBadgeMessage(1e9), { op: "badge", count: 9999 });
  assert.deepEqual(nativeBadgeMessage(Number.NaN), { op: "badge", count: 0 });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  openTargetFromMessage,
  planReconcile,
  pushAvailability,
  pushErrorText,
  subscribePayload,
  type BrowserSub,
  type PushEnv,
} from "./push";
import type { PushStatePayload } from "../proto";

const keyBytes = new Uint8Array(65).map((_, i) => (i * 7 + 4) & 0xff);
const keyB64 = Buffer.from(keyBytes).toString("base64url");
const otherKey = new Uint8Array(65).fill(9);

const server = (over: Partial<PushStatePayload> = {}): PushStatePayload => ({
  enabled: true,
  vapid_public_key: keyB64,
  subscribed: true,
  endpoint: "https://push.example/a",
  scope: "dms",
  key_current: true,
  ...over,
});
const browser = (over: Partial<BrowserSub> = {}): BrowserSub => ({
  endpoint: "https://push.example/a",
  key: keyBytes,
  ...over,
});

test("matching browser and server do nothing", () => {
  assert.deepEqual(planReconcile(server(), "granted", browser()), { kind: "none" });
});

test("push off on the server does nothing, also with a browser subscription", () => {
  assert.deepEqual(planReconcile(server({ enabled: false }), "granted", browser()), { kind: "none" });
  assert.deepEqual(planReconcile(server({ vapid_public_key: undefined }), "granted", null), { kind: "none" });
});

test("a new endpoint from the worker is uploaded with the stored scope", () => {
  assert.deepEqual(
    planReconcile(server({ scope: "all" }), "granted", browser({ endpoint: "https://push.example/b" })),
    { kind: "upload", scope: "all" },
  );
});

test("a server row under an old key is uploaded again when the browser has the current key", () => {
  assert.deepEqual(planReconcile(server({ key_current: false }), "granted", browser()), { kind: "upload", scope: "dms" });
});

test("a browser subscription under another key subscribes again", () => {
  assert.deepEqual(planReconcile(server(), "granted", browser({ key: otherKey })), { kind: "resubscribe", scope: "dms" });
  assert.deepEqual(planReconcile(server(), "granted", browser({ key: null })), { kind: "resubscribe", scope: "dms" });
});

test("a lost browser subscription is made again if the session opted in", () => {
  assert.deepEqual(planReconcile(server(), "granted", null), { kind: "subscribe", scope: "dms" });
});

test("a session that did not opt in drops a leftover browser subscription", () => {
  const s = server({ subscribed: false, endpoint: undefined, scope: undefined, key_current: false });
  assert.deepEqual(planReconcile(s, "granted", browser()), { kind: "drop-browser" });
  assert.deepEqual(planReconcile(s, "granted", null), { kind: "none" });
});

test("revoked permission drops the server row", () => {
  assert.deepEqual(planReconcile(server(), "denied", browser()), { kind: "drop-server", alsoBrowser: true });
  assert.deepEqual(planReconcile(server(), "default", null), { kind: "drop-server", alsoBrowser: false });
  const s = server({ subscribed: false });
  assert.deepEqual(planReconcile(s, "denied", browser()), { kind: "drop-browser" });
  assert.deepEqual(planReconcile(s, "denied", null), { kind: "none" });
});

test("an unknown scope falls back to dms", () => {
  const s = server({ scope: "x" as "dms" });
  assert.deepEqual(planReconcile(s, "granted", null), { kind: "subscribe", scope: "dms" });
});

test("the subscribe payload carries the keys and the key it used", () => {
  const json = { endpoint: "https://push.example/a", keys: { p256dh: "P", auth: "A" } };
  assert.deepEqual(subscribePayload(json, "all", keyB64), {
    endpoint: "https://push.example/a",
    p256dh: "P",
    auth: "A",
    scope: "all",
    vapid_public_key: keyB64,
  });
  assert.equal(subscribePayload({ endpoint: "https://push.example/a" }, "dms", keyB64), null);
  assert.equal(subscribePayload({ keys: { p256dh: "P", auth: "A" } }, "dms", keyB64), null);
});

test("only a chalk-open message with a channel opens a chat", () => {
  assert.deepEqual(openTargetFromMessage({ type: "chalk-open", channelID: "c1", threadID: "t1" }), {
    channelID: "c1",
    threadID: "t1",
  });
  assert.deepEqual(openTargetFromMessage({ type: "chalk-open", channelID: "c1" }), { channelID: "c1" });
  assert.equal(openTargetFromMessage({ type: "chalk-open" }), null);
  assert.equal(openTargetFromMessage({ type: "other", channelID: "c1" }), null);
  assert.equal(openTargetFromMessage(null), null);
  assert.equal(openTargetFromMessage("chalk-open"), null);
});

const env = (over: Partial<PushEnv> = {}): PushEnv => ({
  serverEnabled: true,
  supported: true,
  sealed: true,
  appleMobile: false,
  standalone: false,
  permission: "default",
  ...over,
});

test("push availability goes from the server switch down to the permission", () => {
  assert.equal(pushAvailability(env({ serverEnabled: false, supported: false })), "server-off");
  assert.equal(pushAvailability(env({ appleMobile: true, supported: false })), "ios-home-screen");
  assert.equal(pushAvailability(env({ appleMobile: true, standalone: true })), "ready");
  assert.equal(pushAvailability(env({ supported: false })), "unsupported");
  assert.equal(pushAvailability(env({ sealed: false })), "unsealed");
  assert.equal(pushAvailability(env({ permission: "denied" })), "denied");
  assert.equal(pushAvailability(env({ permission: "granted" })), "ready");
  assert.equal(pushAvailability(env()), "ready");
});

test("push errors map to settings text by their code", () => {
  assert.match(pushErrorText(new Error("push_permission_denied")), /blocked/);
  assert.match(pushErrorText(new Error("push_disabled: push is off")), /off on this server/);
  assert.match(pushErrorText(new Error("push_key_stale: old key")), /try again/);
  assert.match(pushErrorText(new Error("push_no_session: gone")), /sign in again/);
  assert.equal(pushErrorText(new Error("boom")), "push failed: boom");
  assert.equal(pushErrorText("x"), "push failed: x");
});

// 65-7: the page side of web push.
//
// This module registers /sw.js. After every welcome, it makes the browser
// PushSubscription and the server row agree. It uses the frames push_state,
// push_subscribe, and push_unsubscribe on the sealed WebSocket.
//
// Opt-in belongs to a login session. A new login session starts with push
// off. Reconcile drops a browser subscription that an earlier session left.
//
// Only enablePush asks for notification permission. Reconcile never asks.
// The server removes its row with the session at logout, so logout drops
// only the browser subscription.
//
// A chalk-open message from the worker opens a chat. enablePush and
// disablePush have no caller yet. The settings UI in 65-8 calls them.

import {
  TypePushState,
  TypePushSubscribe,
  TypePushUnsubscribe,
  type PushStatePayload,
  type PushSubscribePayload,
} from "../proto";
import { OPEN_MESSAGE, clickTarget, urlBase64ToBytes, type OpenTarget } from "../sw-logic";

/**
 * A PushScope is the set of messages that cause a push: "dms" for direct
 * messages, "all" for every channel message.
 */
export type PushScope = "dms" | "all";

/** The part of WSClient that this module uses. */
export interface PushClient {
  isSealed(): boolean;
  request<P, R = unknown>(type: string, payload?: P): Promise<R>;
}

/** A BrowserSub is the browser subscription as planReconcile sees it. */
export interface BrowserSub {
  endpoint: string;
  /** The applicationServerKey the browser subscribed with. Null if the browser does not show it. */
  key: Uint8Array | null;
}

/**
 * A ReconcileAction is the step that reconcilePush does. The kinds are:
 *
 * - none: do nothing.
 * - upload: send the browser subscription to the server with scope.
 * - subscribe: create a browser subscription, then upload it with scope.
 * - resubscribe: replace the browser subscription, then upload it with scope.
 * - drop-browser: remove the browser subscription.
 * - drop-server: remove the server row, and the browser subscription if alsoBrowser is true.
 */
export type ReconcileAction =
  | { kind: "none" }
  | { kind: "upload"; scope: PushScope }
  | { kind: "subscribe"; scope: PushScope }
  | { kind: "resubscribe"; scope: PushScope }
  | { kind: "drop-browser" }
  | { kind: "drop-server"; alsoBrowser: boolean };

/**
 * planReconcile returns the action that makes the browser subscription
 * agree with the server row. It tests the cases in this order:
 *
 * - The server has push off or sends no key: none.
 * - Permission is not granted and the server row exists: drop-server, with
 *   alsoBrowser true if a browser subscription exists.
 * - Permission is not granted and only a browser subscription exists: drop-browser.
 * - The server has no row for this session and a browser subscription exists: drop-browser.
 * - The server has a row and the browser has no subscription: subscribe,
 *   with the scope of the row.
 * - The browser key differs from the server key: resubscribe, with the scope of the row.
 * - The endpoint differs or key_current is false: upload, with the scope of the row.
 * - Otherwise: none.
 *
 * The scope is "all" if the row says "all", and "dms" in every other case.
 */
export function planReconcile(
  server: PushStatePayload,
  permission: NotificationPermission,
  browser: BrowserSub | null,
): ReconcileAction {
  if (!server.enabled || !server.vapid_public_key) return { kind: "none" };
  if (permission !== "granted") {
    if (server.subscribed) return { kind: "drop-server", alsoBrowser: browser !== null };
    return browser ? { kind: "drop-browser" } : { kind: "none" };
  }
  if (!server.subscribed) return browser ? { kind: "drop-browser" } : { kind: "none" };
  const scope: PushScope = server.scope === "all" ? "all" : "dms";
  if (!browser) return { kind: "subscribe", scope };
  if (!sameKey(browser.key, server.vapid_public_key)) return { kind: "resubscribe", scope };
  if (browser.endpoint !== server.endpoint || !server.key_current) return { kind: "upload", scope };
  return { kind: "none" };
}

function sameKey(key: Uint8Array | null, serverKey: string): boolean {
  if (!key) return false;
  let want: Uint8Array;
  try {
    want = urlBase64ToBytes(serverKey);
  } catch {
    return false;
  }
  if (key.length !== want.length) return false;
  for (let i = 0; i < key.length; i++) if (key[i] !== want[i]) return false;
  return true;
}

/**
 * subscribePayload returns the push_subscribe payload for a browser
 * subscription, with scope and the VAPID key vapidKey. It returns null if
 * the subscription has no endpoint, no p256dh key, or no auth key.
 */
export function subscribePayload(
  json: PushSubscriptionJSON,
  scope: PushScope,
  vapidKey: string,
): PushSubscribePayload | null {
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) return null;
  return { endpoint: json.endpoint, p256dh, auth, scope, vapid_public_key: vapidKey };
}

/**
 * openTargetFromMessage returns the chat that a worker message opens. It
 * returns null if the message is not a chalk-open message or has no channelID.
 */
export function openTargetFromMessage(data: unknown): OpenTarget | null {
  if (typeof data !== "object" || data === null) return null;
  if ((data as { type?: unknown }).type !== OPEN_MESSAGE) return null;
  const t = clickTarget(data);
  return t.channelID ? t : null;
}

// ---- Browser half ------------------------------------------------------

const WORKER_URL = "/sw.js";

/**
 * pushSupported reports whether this browser has service workers, the Push
 * API, and notifications.
 */
export function pushSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    "serviceWorker" in navigator &&
    typeof window !== "undefined" &&
    "PushManager" in window &&
    "Notification" in window
  );
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(WORKER_URL);
  return navigator.serviceWorker.ready;
}

function browserSub(sub: PushSubscription | null): BrowserSub | null {
  if (!sub) return null;
  const k = sub.options?.applicationServerKey;
  return { endpoint: sub.endpoint, key: k ? new Uint8Array(k) : null };
}

async function upload(client: PushClient, sub: PushSubscription, scope: PushScope, key: string): Promise<PushStatePayload> {
  const payload = subscribePayload(sub.toJSON(), scope, key);
  if (!payload) throw new Error("push subscription has no keys");
  return client.request<PushSubscribePayload, PushStatePayload>(TypePushSubscribe, payload);
}

async function freshSub(reg: ServiceWorkerRegistration, key: string): Promise<PushSubscription> {
  const old = await reg.pushManager.getSubscription();
  if (old) await old.unsubscribe();
  return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToBytes(key) });
}

let running: Promise<void> | null = null;

/**
 * reconcilePush makes the browser subscription and the server row agree.
 * App calls it after each welcome. It registers /sw.js, then does the
 * action that planReconcile returns.
 *
 * It does nothing on an unsealed connection, in a browser without push, or
 * when the server has push off. It never asks for permission, so it does not
 * need a user gesture. If a call is already running, it returns that call.
 * It logs an error with console.warn and does not reject.
 */
export function reconcilePush(client: PushClient): Promise<void> {
  if (!pushSupported() || !client.isSealed()) return Promise.resolve();
  if (running) return running;
  running = reconcileOnce(client)
    .catch((err) => console.warn("push reconcile failed:", err))
    .finally(() => {
      running = null;
    });
  return running;
}

async function reconcileOnce(client: PushClient): Promise<void> {
  const server = await client.request<undefined, PushStatePayload>(TypePushState);
  if (!server.enabled || !server.vapid_public_key) return;
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  const action = planReconcile(server, Notification.permission, browserSub(sub));
  const key = server.vapid_public_key;
  switch (action.kind) {
    case "none":
      return;
    case "upload":
      if (sub) await upload(client, sub, action.scope, key);
      return;
    case "subscribe":
    case "resubscribe":
      await upload(client, await freshSub(reg, key), action.scope, key);
      return;
    case "drop-browser":
      await sub?.unsubscribe();
      return;
    case "drop-server":
      await client.request(TypePushUnsubscribe);
      if (action.alsoBrowser) await sub?.unsubscribe();
      return;
  }
}

/**
 * enablePush turns push on for this login session and returns the new
 * server state. It subscribes the browser if needed and sends push_subscribe
 * with scope.
 *
 * Call it from a click handler. It asks for notification permission, and
 * some browsers ask only after a user gesture. It rejects with these errors:
 *
 * - push_unsupported: the browser has no push.
 * - push_permission_denied: the user did not grant permission.
 * - push_disabled: the server has push off.
 *
 * It has no caller yet. The settings UI in 65-8 calls it.
 */
export async function enablePush(client: PushClient, scope: PushScope): Promise<PushStatePayload> {
  if (!pushSupported()) throw new Error("push_unsupported");
  // Ask before the first await, while the gesture is still active.
  const perm = Notification.permission === "default" ? Notification.requestPermission() : Promise.resolve(Notification.permission);
  if ((await perm) !== "granted") throw new Error("push_permission_denied");
  const server = await client.request<undefined, PushStatePayload>(TypePushState);
  if (!server.enabled || !server.vapid_public_key) throw new Error("push_disabled");
  const key = server.vapid_public_key;
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  const keep = sub && sameKey(browserSub(sub)!.key, key) ? sub : await freshSub(reg, key);
  return upload(client, keep, scope, key);
}

/**
 * disablePush turns push off for this login session. It sends
 * push_unsubscribe, drops the browser subscription, and returns the new
 * server state. It has no caller yet. The settings UI in 65-8 calls it.
 */
export async function disablePush(client: PushClient): Promise<PushStatePayload> {
  const state = await client.request<undefined, PushStatePayload>(TypePushUnsubscribe);
  await dropBrowserSubscription();
  return state;
}

/**
 * dropBrowserSubscription removes the browser subscription of /sw.js, if
 * one exists. App calls it at logout. The server row goes with the login
 * session, so this function sends no frame.
 */
export async function dropBrowserSubscription(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration(WORKER_URL);
  const sub = await reg?.pushManager.getSubscription();
  await sub?.unsubscribe();
}

/**
 * installPushOpenListener calls onOpen when a notification click in the
 * worker asks this window to open a chat. It returns the function that
 * removes the listener. In a browser without service workers it installs
 * nothing and returns a function that does nothing.
 */
export function installPushOpenListener(onOpen: (t: OpenTarget) => void): () => void {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
  const handler = (e: MessageEvent) => {
    const t = openTargetFromMessage(e.data);
    if (t) onOpen(t);
  };
  navigator.serviceWorker.addEventListener("message", handler);
  navigator.serviceWorker.startMessages();
  return () => navigator.serviceWorker.removeEventListener("message", handler);
}

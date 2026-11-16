// 136-4d: native push for the iOS app. The page asks the app for an APNs
// registration and sends it to the server. The app is the iOS shell in ios/.
//
// The app gives the page one WebKit reply handler, window.webkit.messageHandlers.chalkPush.
// It exists only inside the app. The page posts {op: "register", prompt}.
// If prompt is true, the app shows the iOS permission prompt when the user has not decided yet.
// The app answers with one of two objects:
//
//   - {ok: true, token, p256dh, auth, topic, environment}: token is lowercase hex,
//     p256dh is a 65-byte P-256 public key, auth is a 16-byte secret, both in base64url.
//     environment is "production" or "sandbox".
//   - {ok: false, error: "denied" | "unavailable"}.
//
// The page treats every other reply as "unavailable" (see parseNativeReply).
// The token and the public key go to the server only on the sealed WebSocket.
//
// Reconcile rule: after each welcome, a session with an APNs row asks the app without a prompt.
// If the token changed or the server key is not current, the page uploads again.
// If the user turned notifications off in the iOS Settings app, the page sends push_unsubscribe.
// If the app cannot answer, the page does nothing.
//
// A tap on a notification reaches the page as a chalk-ios-open event (see installIOSOpenListener).

import {
  TypePushState,
  TypePushSubscribeAPNs,
  TypePushUnsubscribe,
  type PushStatePayload,
  type PushSubscribeAPNsPayload,
} from "../proto";
import { notifyPushSubscribed, type PushClient, type PushScope } from "./push";
import type { OpenTarget } from "../sw-logic";

/** IOS_OPEN_EVENT is the name of the CustomEvent that the app dispatches on window when the user taps a notification. */
export const IOS_OPEN_EVENT = "chalk-ios-open";

const HANDLER = "chalkPush";
const MAX_TOKEN = 200;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A NativeRegistration is the checked content of a successful reply from the app. The token is lowercase hex. */
export interface NativeRegistration {
  token: string;
  p256dh: string;
  auth: string;
  topic: string;
  environment: "production" | "sandbox";
}

/** A NativeReply is a registration, or the reason why the app gave none. "denied" means the user refused notifications. */
export type NativeReply = { ok: true; reg: NativeRegistration } | { ok: false; error: "denied" | "unavailable" };

interface ReplyHandler {
  postMessage(msg: unknown): Promise<unknown>;
}

/**
 * nativePushBridge returns the chalkPush reply handler of w, or null if w has
 * none. It reads the handler structurally. It is not null only inside the iOS app.
 */
export function nativePushBridge(w: unknown = typeof window === "undefined" ? undefined : window): ReplyHandler | null {
  const h = (w as { webkit?: { messageHandlers?: Record<string, unknown> } } | undefined)?.webkit?.messageHandlers?.[
    HANDLER
  ] as Partial<ReplyHandler> | undefined;
  return h && typeof h.postMessage === "function" ? (h as ReplyHandler) : null;
}

// b64urlLength returns the decoded length in bytes of s, or -1 if s is not base64url.
function b64urlLength(s: unknown): number {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]+={0,2}$/.test(s)) return -1;
  const body = s.replace(/=+$/, "");
  if (body.length % 4 === 1) return -1;
  return Math.floor((body.length * 3) / 4);
}

/**
 * parseNativeReply checks a reply from the app and returns it as a NativeReply.
 * A registration is valid if the token is hex of 200 characters or fewer, the
 * key is 65 bytes, the secret is 16 bytes, the topic is not empty, and the
 * environment is "production" or "sandbox". Any other reply is "unavailable".
 */
export function parseNativeReply(x: unknown): NativeReply {
  const unavailable: NativeReply = { ok: false, error: "unavailable" };
  if (typeof x !== "object" || x === null) return unavailable;
  const r = x as Record<string, unknown>;
  if (r.ok !== true) return { ok: false, error: r.error === "denied" ? "denied" : "unavailable" };
  const { token, p256dh, auth, topic, environment } = r;
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN || !/^[0-9a-f]+$/i.test(token)) {
    return unavailable;
  }
  if (b64urlLength(p256dh) !== 65 || b64urlLength(auth) !== 16) return unavailable;
  if (typeof topic !== "string" || topic === "") return unavailable;
  if (environment !== "production" && environment !== "sandbox") return unavailable;
  return {
    ok: true,
    reg: { token: token.toLowerCase(), p256dh: p256dh as string, auth: auth as string, topic, environment },
  };
}

/** apnsPayload returns the push_subscribe_apns payload for reg and scope. */
export function apnsPayload(reg: NativeRegistration, scope: PushScope): PushSubscribeAPNsPayload {
  return { token: reg.token, p256dh: reg.p256dh, auth: reg.auth, scope, topic: reg.topic, environment: reg.environment };
}

/** A NativeReconcileAction is the step that reconcileNativePush does. */
export type NativeReconcileAction = { kind: "none" } | { kind: "upload"; scope: PushScope } | { kind: "drop-server" };

/**
 * planNativeReconcile returns the step that makes the server row of this
 * session agree with the app. It does nothing without an APNs row. If the
 * app reports "denied", it drops the row. If the app is "unavailable", it does
 * nothing. If the token differs or key_current is false, it uploads again with
 * the scope of the row.
 */
export function planNativeReconcile(server: PushStatePayload, reply: NativeReply): NativeReconcileAction {
  if (!server.enabled || !server.apns_topic || !server.subscribed || server.kind !== "apns") return { kind: "none" };
  if (!reply.ok) return reply.error === "denied" ? { kind: "drop-server" } : { kind: "none" };
  const scope: PushScope = server.scope === "all" ? "all" : "dms";
  if (reply.reg.token !== server.endpoint || !server.key_current) return { kind: "upload", scope };
  return { kind: "none" };
}

// register asks the app for a registration. It never throws: a missing bridge or a failed post gives "unavailable".
async function register(prompt: boolean): Promise<NativeReply> {
  const bridge = nativePushBridge();
  if (!bridge) return { ok: false, error: "unavailable" };
  try {
    return parseNativeReply(await bridge.postMessage({ op: "register", prompt }));
  } catch {
    return { ok: false, error: "unavailable" };
  }
}

// upload sends reg to the server, and then tells the onPushSubscribed listeners (87-7).
async function upload(client: PushClient, reg: NativeRegistration, scope: PushScope): Promise<PushStatePayload> {
  const state = await client.request<PushSubscribeAPNsPayload, PushStatePayload>(
    TypePushSubscribeAPNs,
    apnsPayload(reg, scope),
  );
  notifyPushSubscribed();
  return state;
}

/**
 * enableNativePush registers this device for push at the given scope. It asks
 * the app with a prompt, so call it from a click handler. It throws
 * push_native_denied or push_native_unavailable if the app gives no
 * registration. It throws push_disabled if the server offers no APNs.
 */
export async function enableNativePush(client: PushClient, scope: PushScope): Promise<PushStatePayload> {
  const reply = await register(true);
  if (!reply.ok) throw new Error(reply.error === "denied" ? "push_native_denied" : "push_native_unavailable");
  const server = await client.request<undefined, PushStatePayload>(TypePushState);
  if (!server.enabled || !server.apns_topic) throw new Error("push_disabled");
  return upload(client, reply.reg, scope);
}

// running is the reconcile in progress. A second call returns it.
let running: Promise<void> | null = null;

/**
 * reconcileNativePush makes the APNs row of this session agree with the app
 * (see planNativeReconcile). It does nothing outside the app, on an unsealed
 * connection, or if the session has no APNs row. It logs an error and does not throw.
 */
export function reconcileNativePush(client: PushClient): Promise<void> {
  if (!nativePushBridge() || !client.isSealed()) return Promise.resolve();
  if (running) return running;
  running = (async () => {
    const server = await client.request<undefined, PushStatePayload>(TypePushState);
    if (!server.subscribed || server.kind !== "apns") return;
    const reply = await register(false);
    const action = planNativeReconcile(server, reply);
    if (action.kind === "upload" && reply.ok) {
      await upload(client, reply.reg, action.scope);
    } else if (action.kind === "drop-server") {
      await client.request(TypePushUnsubscribe);
    }
  })()
    .catch((err) => console.warn("native push reconcile failed:", err))
    .finally(() => {
      running = null;
    });
  return running;
}

/**
 * openTargetFromIOS returns the target of a chalk-ios-open event, or null. Only
 * UUIDs pass. A target needs a channelID or a reminderID.
 */
export function openTargetFromIOS(detail: unknown): OpenTarget | null {
  if (typeof detail !== "object" || detail === null) return null;
  const d = detail as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === "string" && ID_RE.test(v) ? v : undefined);
  const t: OpenTarget = { channelID: id(d.channelID), threadID: id(d.threadID), reminderID: id(d.reminderID) };
  if (!t.channelID) delete t.channelID;
  if (!t.threadID) delete t.threadID;
  if (!t.reminderID) delete t.reminderID;
  return t.channelID || t.reminderID ? t : null;
}

/**
 * installIOSOpenListener calls onOpen for each valid chalk-ios-open event. It
 * returns the function that removes the listener. Outside the app it does nothing.
 */
export function installIOSOpenListener(onOpen: (t: OpenTarget) => void): () => void {
  if (typeof window === "undefined" || !nativePushBridge()) return () => {};
  const handler = (e: Event) => {
    const t = openTargetFromIOS((e as CustomEvent).detail);
    if (t) onOpen(t);
  };
  window.addEventListener(IOS_OPEN_EVENT, handler);
  return () => window.removeEventListener(IOS_OPEN_EVENT, handler);
}

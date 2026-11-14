// 65-6: the pure half of the service worker (sw.ts). It turns a push
// payload into a notification and a notification click into a target. It
// uses no worker or DOM globals, so test.mjs runs it under node.

/** The plaintext of a push. See pushPayload in internal/server/push_dispatch.go. */
export interface PushPayload {
  v: number;
  kind: string;
  channel_id: string;
  message_id: string;
  thread_id?: string;
  sender_handle: string;
  channel_name?: string;
  is_dm: boolean;
  unread: number;
}

/** What a notification click opens. If the fields are empty, the click opens the app unchanged. */
export interface OpenTarget {
  channelID?: string;
  threadID?: string;
}

export interface NotificationSpec {
  title: string;
  options: {
    body: string;
    tag: string;
    icon?: string;
    data: OpenTarget;
  };
  /** The app icon badge, or null to leave it unchanged. */
  badge: number | null;
}

/** The type of the message that the worker posts to an open chalk window. */
export const OPEN_MESSAGE = "chalk-open";

const GENERIC_TAG = "chalk-push";

/**
 * parsePushPayload returns the payload. It returns null if data is not a
 * version-1 message payload. The caller must still show a notification for
 * null, because iOS revokes a subscription that receives pushes without one.
 */
export function parsePushPayload(data: unknown): PushPayload | null {
  if (typeof data !== "object" || data === null) return null;
  const p = data as Record<string, unknown>;
  if (p.v !== 1 || p.kind !== "message") return null;
  if (typeof p.channel_id !== "string" || typeof p.message_id !== "string") return null;
  return {
    v: 1,
    kind: "message",
    channel_id: p.channel_id,
    message_id: p.message_id,
    thread_id: typeof p.thread_id === "string" && p.thread_id ? p.thread_id : undefined,
    sender_handle: typeof p.sender_handle === "string" ? p.sender_handle : "",
    channel_name: typeof p.channel_name === "string" && p.channel_name ? p.channel_name : undefined,
    is_dm: p.is_dm === true,
    unread: typeof p.unread === "number" && Number.isFinite(p.unread) ? Math.max(0, Math.floor(p.unread)) : 0,
  };
}

/**
 * notificationFor returns the notification for a payload. For null it
 * returns the generic notification. The tags match the in-app banners
 * (notify/banners.ts), so a second push for the same channel or thread
 * replaces the first.
 */
export function notificationFor(p: PushPayload | null, icon?: string): NotificationSpec {
  if (!p) {
    return { title: "chalk", options: { body: "New activity", tag: GENERIC_TAG, icon, data: {} }, badge: null };
  }
  const sender = p.sender_handle ? `@${p.sender_handle}` : "someone";
  let title: string;
  if (p.is_dm) title = sender;
  else if (p.channel_name) title = `${sender} in #${p.channel_name}`;
  else title = sender;
  const body = p.thread_id ? "New reply in a thread" : "New message";
  const tag = p.thread_id ? `chalk-th-${p.thread_id}` : `chalk-ch-${p.channel_id}`;
  return {
    title,
    options: { body, tag, icon, data: { channelID: p.channel_id, threadID: p.thread_id } },
    badge: p.unread,
  };
}

/** clickTarget returns the target that the notification data holds. */
export function clickTarget(data: unknown): OpenTarget {
  if (typeof data !== "object" || data === null) return {};
  const d = data as Record<string, unknown>;
  const out: OpenTarget = {};
  if (typeof d.channelID === "string" && d.channelID) out.channelID = d.channelID;
  if (typeof d.threadID === "string" && d.threadID && out.channelID) out.threadID = d.threadID;
  return out;
}

// 65-9: the ids that the click URL carries. Both sides check them, so the
// query string never holds anything but a channel id and a thread id.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * openURL returns the URL that the worker opens when no chalk window exists.
 * It is "/?open=<channel>&thread=<thread>" for a valid target. The thread
 * part is left out if threadID is missing or invalid. It returns "/" if
 * channelID is missing or invalid.
 */
export function openURL(t: OpenTarget): string {
  if (!t.channelID || !ID_RE.test(t.channelID)) return "/";
  const q = new URLSearchParams({ open: t.channelID });
  if (t.threadID && ID_RE.test(t.threadID)) q.set("thread", t.threadID);
  return `/?${q.toString()}`;
}

/**
 * parseOpenURL returns the target in a query string that openURL made.
 * It returns null if the "open" value is missing or invalid. It ignores an
 * invalid "thread" value.
 */
export function parseOpenURL(search: string): OpenTarget | null {
  const q = new URLSearchParams(search);
  const channelID = q.get("open") ?? "";
  if (!ID_RE.test(channelID)) return null;
  const threadID = q.get("thread") ?? "";
  return ID_RE.test(threadID) ? { channelID, threadID } : { channelID };
}

/** urlBase64ToBytes decodes a base64url VAPID key into bytes for applicationServerKey. */
export function urlBase64ToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

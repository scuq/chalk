// 65-6: the pure half of the service worker (sw.ts). It turns a push
// payload into a notification and a notification click into a target. It
// uses no worker or DOM globals, so test.mjs runs it under node.

/** The plaintext of a push. See pushPayload in internal/server/push_dispatch.go. */
export interface MessagePushPayload {
  v: number;
  kind: "message";
  channel_id: string;
  message_id: string;
  thread_id?: string;
  sender_handle: string;
  channel_name?: string;
  is_dm: boolean;
  unread: number;
}

/**
 * 87-8: the plaintext of a reminder push. See reminderPushPayload in
 * internal/server/reminder_push.go. It holds the ID of the reminder and
 * nothing about the message.
 */
export interface ReminderPushPayload {
  v: number;
  kind: "reminder";
  reminder_id: string;
}

/** The plaintext of a push: a message payload or a reminder payload. */
export type PushPayload = MessagePushPayload | ReminderPushPayload;

/**
 * What a notification click opens. If the fields are empty, the click opens
 * the app unchanged. A reminderID stands alone: the page finds the channel
 * and the message in its reminder set.
 */
export interface OpenTarget {
  channelID?: string;
  threadID?: string;
  reminderID?: string;
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
 * version-1 message payload or a version-1 reminder payload with a valid ID.
 * The caller must still show a notification for null, because iOS revokes a
 * subscription that receives pushes without one.
 */
export function parsePushPayload(data: unknown): PushPayload | null {
  if (typeof data !== "object" || data === null) return null;
  const p = data as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (p.kind === "reminder") {
    if (typeof p.reminder_id !== "string" || !ID_RE.test(p.reminder_id)) return null;
    return { v: 1, kind: "reminder", reminder_id: p.reminder_id };
  }
  if (p.kind !== "message") return null;
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
 * replaces the first. A reminder notification leaves the app badge
 * unchanged.
 */
export function notificationFor(p: PushPayload | null, icon?: string): NotificationSpec {
  if (!p) {
    return { title: "chalk", options: { body: "New activity", tag: GENERIC_TAG, icon, data: {} }, badge: null };
  }
  if (p.kind === "reminder") {
    // 87-8: The worker has no key, so it cannot show the message. The tag is
    // the tag of the in-app reminder banner, so one replaces the other.
    return {
      title: "chalk",
      options: {
        body: "Reminder: a message is due",
        tag: `chalk-rem-${p.reminder_id}`,
        icon,
        data: { reminderID: p.reminder_id },
      },
      badge: null,
    };
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
  if (typeof d.reminderID === "string" && d.reminderID) out.reminderID = d.reminderID;
  return out;
}

// 65-9: the ids that the click URL carries. Both sides check them, so the
// query string never holds anything but a channel id and a thread id.
const ID_RE = /^[A-Za-z0-9-]{1,64}$/;

/**
 * openURL returns the URL that the worker opens when no chalk window exists.
 * If reminderID is valid, it is "/?reminder=<id>". Otherwise it is
 * "/?open=<channel>&thread=<thread>" for a valid target. The thread part is
 * left out if threadID is missing or invalid. It returns "/" if channelID
 * is missing or invalid.
 */
export function openURL(t: OpenTarget): string {
  if (t.reminderID && ID_RE.test(t.reminderID)) {
    return `/?${new URLSearchParams({ reminder: t.reminderID }).toString()}`;
  }
  if (!t.channelID || !ID_RE.test(t.channelID)) return "/";
  const q = new URLSearchParams({ open: t.channelID });
  if (t.threadID && ID_RE.test(t.threadID)) q.set("thread", t.threadID);
  return `/?${q.toString()}`;
}

/**
 * parseOpenURL returns the target in a query string that openURL made.
 * If the "reminder" value is valid, the target is that reminder alone.
 * Otherwise it returns null if the "open" value is missing or invalid. It
 * ignores an invalid "thread" value.
 */
export function parseOpenURL(search: string): OpenTarget | null {
  const q = new URLSearchParams(search);
  const reminderID = q.get("reminder") ?? "";
  if (ID_RE.test(reminderID)) return { reminderID };
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

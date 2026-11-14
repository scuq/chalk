/// <reference lib="webworker" />
// 65-6: the service worker. build.mjs builds it to the unhashed file
// dist/sw.js, and spa.go serves it with Cache-Control: no-cache. A browser
// checks for a new worker on every registration.
//
// It has no fetch handler on purpose. chalk loads from the network, and the
// worker cannot break that. The worker shows pushes, opens chalk from a
// click, and subscribes again after the browser replaces the subscription.
// It keeps no state.

import { OPEN_MESSAGE, clickTarget, notificationFor, parsePushPayload } from "./sw-logic";

declare const self: ServiceWorkerGlobalScope;
// The hashed URL of the 192 px app icon. build.mjs sets it with a define.
declare const __CHALK_ICON__: string;

self.addEventListener("install", () => {
  // A new worker takes over at once. It holds no state that an old page
  // can depend on.
  void self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  event.waitUntil(showPush(event.data));
});

async function showPush(data: PushMessageData | null): Promise<void> {
  let payload: unknown = null;
  try {
    payload = data ? data.json() : null;
  } catch {
    payload = null;
  }
  // Every push shows a notification, also a push that does not parse. iOS
  // revokes a subscription that receives pushes without a notification.
  const n = notificationFor(parsePushPayload(payload), __CHALK_ICON__);
  await self.registration.showNotification(n.title, n.options);
  if (n.badge !== null) {
    try {
      const nav = self.navigator as Navigator & {
        setAppBadge?: (n?: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
      };
      if (n.badge > 0) await nav.setAppBadge?.(n.badge);
      else await nav.clearAppBadge?.();
    } catch {
      // The badge is optional. A browser without it still shows the push.
    }
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openChalk(clickTarget(event.notification.data)));
});

async function openChalk(target: { channelID?: string; threadID?: string }): Promise<void> {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const own = windows.filter((c) => new URL(c.url).origin === self.location.origin);
  const win = own.find((c) => c.focused) ?? own[0];
  if (win) {
    await win.focus();
    if (target.channelID) win.postMessage({ type: OPEN_MESSAGE, ...target });
    return;
  }
  await self.clients.openWindow("/");
}

self.addEventListener("pushsubscriptionchange", (event) => {
  // The browser replaced or dropped the subscription. Subscribe again with
  // the same server key. The page uploads the new subscription over the
  // sealed WebSocket at its next start (65-7). If the old key is not
  // available, the worker cannot subscribe, and the page subscribes at its
  // next start.
  const ev = event as Event & {
    oldSubscription?: PushSubscription | null;
    waitUntil(p: Promise<unknown>): void;
  };
  const key = ev.oldSubscription?.options?.applicationServerKey ?? null;
  if (!key) return;
  ev.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: key })
      .catch(() => undefined),
  );
});

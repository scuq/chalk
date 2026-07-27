// chalk-web -- the notification bus.
//
// Every candidate notification -- a message that survived classify, a
// call starting, a friend request -- is normalized into one NotifyEvent
// and published here. The consumer (App.tsx) resolves it against the
// rules (rules.ts) and drives the sinks. Publishers never decide what
// happens; they only report what occurred, with the display facts
// already resolved (handles, channel names, decrypted preview), because
// only the publish site has the refs to resolve them.
//
// Same shape as the prefs listener set: a module-level Set, not an
// EventTarget, because subscribers are few, synchronous, and in-process.

import type { NotifyEventType } from "./rules";

export interface NotifyEvent {
  type: NotifyEventType;
  senderUserID?: string;
  channelID?: string;
  threadID?: string;
  isDM?: boolean;
  // Display facts for the sinks that show text (banner). Decrypted
  // client-side before publish; nothing here ever leaves the device.
  senderHandle?: string;
  channelName?: string;
  preview?: string;
}

const subscribers = new Set<(ev: NotifyEvent) => void>();

export function publishNotifyEvent(ev: NotifyEvent): void {
  for (const fn of subscribers) fn(ev);
}

export function subscribeNotifyEvents(fn: (ev: NotifyEvent) => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

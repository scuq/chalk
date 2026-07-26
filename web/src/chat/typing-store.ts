// chalk-web -- who is currently typing, per channel.
//
// A module singleton with its own timer rather than a slice of AppState, on
// the voiceSession precedent (../voice/session.ts). Two reasons:
//
//   * the reducer is pure and cannot hold a timer, and driving expiry from a
//     1s dispatch would rebuild AppState -- and re-render the whole message
//     list -- once a second, forever, for a one-line indicator;
//   * nothing here is persisted or shared. It is derived entirely from pushes
//     that stop arriving, which is exactly the kind of state that has no
//     business surviving a reload.
//
// Everything that decides *what to show* is in typing.ts and is pure; this
// file owns only the mutation and the clock.

import { useEffect, useState } from "preact/hooks";

import { TYPING_TTL_MS, liveTypists } from "./typing";

const SWEEP_INTERVAL_MS = 1000;

class TypingStore {
  // channelID -> userID -> expiry (epoch ms).
  //
  // Insertion order is load-bearing and is why these are Maps: it is what
  // orders the names in the line, and re-setting an existing key does NOT
  // move it, so a typist re-pinging every 3s never reshuffles the sentence
  // under the reader.
  private byChannel = new Map<string, Map<string, number>>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** typistsIn returns the userIDs still typing in a channel, in arrival order. */
  typistsIn(channelID: string, nowMs: number): string[] {
    const entries = this.byChannel.get(channelID);
    if (!entries) return [];
    return liveTypists(entries, nowMs);
  }

  /** note records (or refreshes) one person typing in one channel. */
  note(channelID: string, userID: string, nowMs: number): void {
    let entries = this.byChannel.get(channelID);
    if (!entries) {
      entries = new Map();
      this.byChannel.set(channelID, entries);
    }
    entries.set(userID, nowMs + TYPING_TTL_MS);
    this.startTicking();
    this.emit();
  }

  /**
   * clearUser drops one person immediately. Called when a message from them
   * arrives -- they were typing it, and they have now stopped.
   */
  clearUser(channelID: string, userID: string): void {
    const entries = this.byChannel.get(channelID);
    if (!entries || !entries.delete(userID)) return;
    if (entries.size === 0) this.byChannel.delete(channelID);
    this.emit();
  }

  clearChannel(channelID: string): void {
    if (!this.byChannel.delete(channelID)) return;
    this.emit();
  }

  /**
   * clearAll drops everything and stops the clock. Used when the socket
   * drops (names frozen across a reconnect are worse than none) and when the
   * viewer turns the feature off.
   */
  clearAll(): void {
    this.stopTicking();
    if (this.byChannel.size === 0) return;
    this.byChannel.clear();
    this.emit();
  }

  /**
   * sweep drops everything that has expired. The clock is a parameter, not a
   * call to Date.now(), which is the single thing that makes this store
   * testable without fake timers.
   */
  sweep(nowMs: number): void {
    let changed = false;
    for (const [channelID, entries] of this.byChannel) {
      for (const [userID, expiresAt] of entries) {
        if (expiresAt > nowMs) continue;
        entries.delete(userID);
        changed = true;
      }
      if (entries.size === 0) this.byChannel.delete(channelID);
    }
    if (this.byChannel.size === 0) this.stopTicking();
    if (changed) this.emit();
  }

  /** isTicking reports whether the sweep timer is running. For tests. */
  isTicking(): boolean {
    return this.timer !== null;
  }

  private startTicking(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.sweep(Date.now()), SWEEP_INTERVAL_MS);
    // Node keeps a process alive for a pending interval, which would hang the
    // test runner. Browsers have no unref and need none.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private stopTicking(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn();
      } catch (err) {
        console.error("typing store listener threw:", err);
      }
    }
  }
}

export const typingStore = new TypingStore();

function sameIDs(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * useTypists subscribes a component to one channel's typists.
 *
 * Returns the previous array when nothing changed so the sweep timer's
 * once-a-second wake-up doesn't re-render anything at rest.
 */
export function useTypists(channelID: string | null): string[] {
  const [ids, setIDs] = useState<string[]>([]);
  useEffect(() => {
    if (!channelID) {
      setIDs([]);
      return;
    }
    const read = () =>
      setIDs((prev) => {
        const next = typingStore.typistsIn(channelID, Date.now());
        return sameIDs(prev, next) ? prev : next;
      });
    read();
    return typingStore.subscribe(read);
  }, [channelID]);
  return ids;
}

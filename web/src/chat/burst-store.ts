// 115-1: which channels are hot -- more than N live messages in M minutes.
//
// A module singleton with its own clock, on the typingStore precedent
// (./typing-store.ts) and for the same two reasons: the reducer is pure and
// cannot hold a timer, and none of this deserves to survive a reload. A
// flame is a fact about the last few minutes, derived from pushes that were
// seen arrive; a channel that was busy before the page loaded is not busy
// *to this reader*, which is also why the store is fed from the live push
// and never from history.
//
// The verdict is deliberately sticky. A channel becomes hot the moment the
// Nth message inside the window lands, and stays hot until the window has
// passed since its *last* message -- not since the Nth. Counting strictly
// would put the flame out and relight it as the oldest message of a burst
// slid out of the window while new ones kept coming, which reads as a fault
// rather than a signal.

import { useEffect, useState } from "preact/hooks";

// The sweep exists to put flames out. Once every five seconds is plenty for
// a window measured in minutes, and is nothing at rest because the timer
// only runs while some channel is hot or on its way there.
const SWEEP_INTERVAL_MS = 5000;

interface Channel {
  // Arrival times inside the current window, oldest first, never more than
  // the threshold count long -- the (count+1)th is dropped from the front.
  recent: number[];
  // Epoch ms until which the channel is hot, or 0.
  hotUntil: number;
}

class BurstStore {
  private byChannel = new Map<string, Channel>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  // The threshold the store applies. Set by the reader's prefs; both are
  // clamped upstream (display-prefs.ts), so they are trusted here.
  private count = 4;
  private windowMs = 4 * 60_000;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /**
   * configure sets the threshold. Existing verdicts are re-derived from the
   * arrivals still remembered, so lowering the count can light a flame at
   * once and raising it can put one out; either way the reader sees the
   * setting take effect without waiting for the next message.
   */
  configure(count: number, windowMs: number, nowMs: number): void {
    if (count === this.count && windowMs === this.windowMs) return;
    this.count = count;
    this.windowMs = windowMs;
    let changed = false;
    for (const ch of this.byChannel.values()) {
      const was = ch.hotUntil > nowMs;
      this.trim(ch, nowMs);
      ch.hotUntil =
        ch.recent.length >= this.count ? ch.recent[ch.recent.length - 1] + this.windowMs : 0;
      if ((ch.hotUntil > nowMs) !== was) changed = true;
    }
    if (changed) this.emit();
  }

  /** note records one live message arriving in a channel. */
  note(channelID: string, nowMs: number): void {
    let ch = this.byChannel.get(channelID);
    if (!ch) {
      ch = { recent: [], hotUntil: 0 };
      this.byChannel.set(channelID, ch);
    }
    const was = ch.hotUntil > nowMs;
    ch.recent.push(nowMs);
    this.trim(ch, nowMs);
    if (ch.recent.length >= this.count) ch.hotUntil = nowMs + this.windowMs;
    this.startTicking();
    if (ch.hotUntil > nowMs && !was) this.emit();
  }

  /** hot reports whether a channel is currently burning. */
  hot(channelID: string, nowMs: number): boolean {
    const ch = this.byChannel.get(channelID);
    return !!ch && ch.hotUntil > nowMs;
  }

  /** countIn returns how many remembered arrivals fall inside the window. */
  countIn(channelID: string, nowMs: number): number {
    const ch = this.byChannel.get(channelID);
    if (!ch) return 0;
    return ch.recent.filter((t) => t > nowMs - this.windowMs).length;
  }

  /** hotChannels returns every burning channel's id. */
  hotChannels(nowMs: number): Set<string> {
    const out = new Set<string>();
    for (const [id, ch] of this.byChannel) {
      if (ch.hotUntil > nowMs) out.add(id);
    }
    return out;
  }

  /**
   * sweep forgets arrivals that left the window and puts out flames whose
   * time is up. The clock is a parameter, not Date.now(), which is what
   * makes the store testable without fake timers.
   */
  sweep(nowMs: number): void {
    let changed = false;
    for (const [id, ch] of this.byChannel) {
      this.trim(ch, nowMs);
      // A flame the store still records as lit whose time has come: put it
      // out and say so. Readers compare against now themselves, so the
      // notification -- not the value -- is what repaints the roster.
      if (ch.hotUntil !== 0 && ch.hotUntil <= nowMs) {
        ch.hotUntil = 0;
        changed = true;
      }
      if (ch.recent.length === 0 && ch.hotUntil === 0) this.byChannel.delete(id);
    }
    if (this.byChannel.size === 0) this.stopTicking();
    if (changed) this.emit();
  }

  /**
   * clearAll forgets everything and stops the clock. Called when the socket
   * drops -- a flame frozen across a reconnect is a lie -- and when the
   * reader turns the feature off.
   */
  clearAll(): void {
    this.stopTicking();
    if (this.byChannel.size === 0) return;
    const wasHot = this.hotChannels(Number.POSITIVE_INFINITY).size > 0;
    this.byChannel.clear();
    if (wasHot) this.emit();
  }

  /** isTicking reports whether the sweep timer is running. For tests. */
  isTicking(): boolean {
    return this.timer !== null;
  }

  private trim(ch: Channel, nowMs: number): void {
    const floor = nowMs - this.windowMs;
    while (ch.recent.length > 0 && ch.recent[0] <= floor) ch.recent.shift();
    while (ch.recent.length > this.count) ch.recent.shift();
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
        console.error("burst store listener threw:", err);
      }
    }
  }
}

export const burstStore = new BurstStore();

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * useHotChannels subscribes a component to the set of burning channels under
 * the given threshold. `enabled` false yields an empty set without touching
 * the store, so a reader with flair off pays nothing.
 *
 * Returns the previous set when nothing changed, so the sweep's wake-ups do
 * not re-render the roster at rest.
 */
export function useHotChannels(
  enabled: boolean,
  count: number,
  minutes: number,
): ReadonlySet<string> {
  const [hot, setHot] = useState<ReadonlySet<string>>(NONE);
  useEffect(() => {
    if (!enabled) {
      setHot(NONE);
      return;
    }
    burstStore.configure(count, minutes * 60_000, Date.now());
    const read = () =>
      setHot((prev) => {
        const next = burstStore.hotChannels(Date.now());
        return sameSet(prev, next) ? prev : next;
      });
    read();
    return burstStore.subscribe(read);
  }, [enabled, count, minutes]);
  return hot;
}

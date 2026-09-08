// 115-3: who is waving -- a friend's name in the roster, for a moment.
//
// A module singleton with its own clock, the typingStore shape (see
// ./typing-store.ts for why: the reducer is pure, and a transient effect
// has no business in persisted state). A wave is triggered by two things
// that App already detects -- a friend coming online, and a DM arriving --
// and lasts WAVE_MS from the trigger. Re-triggering restarts it: the
// component keys its markup on the start time, so a fresh start is a fresh
// mount and a fresh animation.

import { useEffect, useState } from "preact/hooks";

import { WAVE_MS } from "./wave";

// Waves are short, so the sweep is frequent while any are running and
// silent otherwise.
const SWEEP_INTERVAL_MS = 500;

class WaveStore {
  // userID -> epoch ms the wave started.
  private since = new Map<string, number>();
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** trigger starts (or restarts) one person's wave. */
  trigger(userID: string, nowMs: number): void {
    this.since.set(userID, nowMs);
    this.startTicking();
    this.emit();
  }

  /** activeFor returns when a person's wave started, or null once it is over. */
  activeFor(userID: string, nowMs: number): number | null {
    const t = this.since.get(userID);
    return t !== undefined && nowMs < t + WAVE_MS ? t : null;
  }

  /** active returns every running wave, by user. */
  active(nowMs: number): Map<string, number> {
    const out = new Map<string, number>();
    for (const [id, t] of this.since) {
      if (nowMs < t + WAVE_MS) out.set(id, t);
    }
    return out;
  }

  /**
   * sweep forgets waves that have finished. The clock is a parameter, not
   * Date.now(), so the store is testable without fake timers.
   */
  sweep(nowMs: number): void {
    let changed = false;
    for (const [id, t] of this.since) {
      if (nowMs < t + WAVE_MS) continue;
      this.since.delete(id);
      changed = true;
    }
    if (this.since.size === 0) this.stopTicking();
    if (changed) this.emit();
  }

  /** clearAll drops every wave and stops the clock. */
  clearAll(): void {
    this.stopTicking();
    if (this.since.size === 0) return;
    this.since.clear();
    this.emit();
  }

  /** isTicking reports whether the sweep timer is running. For tests. */
  isTicking(): boolean {
    return this.timer !== null;
  }

  private startTicking(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.sweep(Date.now()), SWEEP_INTERVAL_MS);
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
        console.error("wave store listener threw:", err);
      }
    }
  }
}

export const waveStore = new WaveStore();

function sameWaves(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, t] of a) if (b.get(id) !== t) return false;
  return true;
}

const NONE: ReadonlyMap<string, number> = new Map();

/**
 * useWaves subscribes a component to the running waves. One subscription
 * for a whole roster, not one per row; rows look their person up in the
 * map. Returns the previous map when nothing changed.
 */
export function useWaves(enabled: boolean): ReadonlyMap<string, number> {
  const [waves, setWaves] = useState<ReadonlyMap<string, number>>(NONE);
  useEffect(() => {
    if (!enabled) {
      setWaves(NONE);
      return;
    }
    const read = () =>
      setWaves((prev) => {
        const next = waveStore.active(Date.now());
        return sameWaves(prev, next) ? prev : next;
      });
    read();
    return waveStore.subscribe(read);
  }, [enabled]);
  return waves;
}

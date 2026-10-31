// chalk-web -- 129-1: the peek schedule.
//
// The figure is not always there. It appears, stays a while, fades, and comes
// back after a longer, random pause -- so it reads as a visitor, not as
// furniture. Pure: the random source is a parameter, so the tests pin the
// bounds. The component owns the one timer that walks this schedule.

/** A step of the schedule: whether the figure shows, and for how long. */
export interface Peek {
  visible: boolean;
  ms: number;
}

/** [low, high] bounds in milliseconds, inclusive. */
export type Range = [number, number];

// The first pause keeps the figure from popping in on the first paint.
export const FIRST_PAUSE_MS: Range = [4_000, 12_000];
export const SHOW_MS: Range = [8_000, 15_000];
export const HIDE_MS: Range = [25_000, 90_000];

function pick([lo, hi]: Range, rnd: () => number): number {
  const r = rnd();
  const t = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5;
  return Math.round(lo + (hi - lo) * t);
}

/** firstPeek returns the schedule's opening step: hidden, for a short pause. */
export function firstPeek(rnd: () => number = Math.random): Peek {
  return { visible: false, ms: pick(FIRST_PAUSE_MS, rnd) };
}

/**
 * nextPeek returns the step that follows a step in which the figure was
 * `visible`: hidden for a long pause after a showing, shown for a short while
 * after a pause.
 */
export function nextPeek(visible: boolean, rnd: () => number = Math.random): Peek {
  return visible
    ? { visible: false, ms: pick(HIDE_MS, rnd) }
    : { visible: true, ms: pick(SHOW_MS, rnd) };
}

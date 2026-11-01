// chalk-web -- 129-1: the peek schedule. 129-7: the daily cap.
//
// The figure is not always there. It is a visitor, not furniture. A visit
// shows for a few seconds. Visits are few: at most MAX_VISITS_PER_DAY in one
// local calendar day, with 1 to 2 hours between the starts of two visits.
// Pure: the clock and the random source are parameters, so the tests pin the
// bounds. This module keeps no state. The log of visits is in visits.ts. The
// component owns the one timer that walks this schedule.

/** A step of the schedule: whether the figure shows, and for how long. */
export interface Peek {
  visible: boolean;
  ms: number;
}

/** [low, high] bounds in milliseconds, inclusive. */
export type Range = [number, number];

// The first pause keeps the figure from popping in on the first paint. It
// applies at each page load, but a visit follows it only if the log allows one.
export const FIRST_PAUSE_MS: Range = [4_000, 12_000];

/** How long one visit shows, in milliseconds. */
export const SHOW_MS: Range = [8_000, 15_000];

/**
 * CHECK_MS is the time between two checks while the figure is hidden. This one
 * poll covers a new local day at midnight, a claim by another tab, and a page
 * that was in the background.
 */
export const CHECK_MS = 60_000;

/**
 * GAP_MS is the time from the start of one visit to the earliest start of the
 * next, in milliseconds. It is 1 to 2 hours.
 */
export const GAP_MS: Range = [3_600_000, 7_200_000];

/**
 * MAX_VISITS_PER_DAY is the most visits in one local calendar day. The gaps
 * make the real number lower: 10 visits need chalk open for about 10 to 20
 * hours.
 */
export const MAX_VISITS_PER_DAY = 10;

/**
 * A VisitLog records the visits of one local calendar day.
 *
 * day is the local date of the visits, as made by dayKey. count is the number
 * of visits started on that day. nextAt is the earliest time of the next visit,
 * in milliseconds since the epoch.
 */
export interface VisitLog {
  day: string;
  count: number;
  nextAt: number;
}

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
 * nextPeek returns the step after a timer. If show is true, the figure shows
 * for a time in SHOW_MS. If show is false, the figure stays hidden until the
 * next check, CHECK_MS later.
 */
export function nextPeek(show: boolean, rnd: () => number = Math.random): Peek {
  return show ? { visible: true, ms: pick(SHOW_MS, rnd) } : { visible: false, ms: CHECK_MS };
}

// The local calendar date of now, as one string. The month is 1-based.
function dayKey(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

/**
 * claimVisit returns the log after a new visit, or null if no visit
 * is due. It does not change log.
 *
 * It returns null in two cases:
 *
 *   - The log has MAX_VISITS_PER_DAY visits for the local day of now.
 *   - nextAt is in the future by no more than the longest gap, GAP_MS[1].
 *
 * A log from an earlier day counts as zero visits. A nextAt further away than
 * the longest gap cannot come from this schedule, so the system clock was
 * moved back. It counts as due. Without this rule, a changed system date could
 * silence the figure for days.
 */
export function claimVisit(
  log: VisitLog,
  now: number,
  rnd: () => number = Math.random,
): VisitLog | null {
  const day = dayKey(now);
  const count = log.day === day ? log.count : 0;
  const wait = log.nextAt - now;
  if (count >= MAX_VISITS_PER_DAY || (wait > 0 && wait <= GAP_MS[1])) return null;
  return { day, count: count + 1, nextAt: now + pick(GAP_MS, rnd) };
}

// chalk-web -- 129-1: the peek schedule. 129-7: the daily cap. 129-9: the
// evening.
//
// The scene is not always there. It is a visitor, not furniture. A visit
// shows for 45 s to 75 s. Visits are few: at most MAX_VISITS_PER_DAY in one
// local calendar day. Before EVENING_HOUR, at most MAX_DAYTIME_VISITS of them
// can start, so a tab that stays open all day does not use up the evening.
// The gap between the starts of two visits is 1 to 2 hours in the daytime and
// 20 to 40 minutes in the evening.
// Pure: the clock and the random source are parameters, so the tests pin the
// bounds. This module keeps no state. The log of visits is in visits.ts. The
// component owns the one timer that walks this schedule.

/** A step of the schedule: whether the scene shows, and for how long. */
export interface Peek {
  visible: boolean;
  ms: number;
}

/** [low, high] bounds in milliseconds, inclusive. */
export type Range = [number, number];

// The first pause keeps the scene from popping in on the first paint. It
// applies at each page load, but a visit follows it only if the log allows one.
export const FIRST_PAUSE_MS: Range = [4_000, 12_000];

/** How long one visit shows, in milliseconds. */
export const SHOW_MS: Range = [45_000, 75_000];

/**
 * CHECK_MS is the time between two checks while the scene is hidden. This one
 * poll covers a new local day at midnight, a claim by another tab, and a page
 * that was in the background.
 */
export const CHECK_MS = 60_000;

/**
 * GAP_MS is the time from the start of one visit to the earliest start of the
 * next, in milliseconds, for a visit that starts before EVENING_HOUR. It is 1
 * to 2 hours.
 */
export const GAP_MS: Range = [3_600_000, 7_200_000];

/**
 * EVENING_GAP_MS is the same time as GAP_MS for a visit that starts at
 * EVENING_HOUR or later. It is 20 to 40 minutes.
 */
export const EVENING_GAP_MS: Range = [1_200_000, 2_400_000];

/** EVENING_HOUR is the local hour, 0 to 23, at which the evening starts. It is 18. */
export const EVENING_HOUR = 18;

/**
 * MAX_VISITS_PER_DAY is the most visits in one local calendar day. The gaps
 * make the real number lower.
 */
export const MAX_VISITS_PER_DAY = 16;

/**
 * MAX_DAYTIME_VISITS is the most visits that can have started before
 * EVENING_HOUR on one local calendar day. The evening can then have at least
 * MAX_VISITS_PER_DAY minus this number.
 */
export const MAX_DAYTIME_VISITS = 10;

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
 * nextPeek returns the step after a timer. If show is true, the scene shows
 * for a time in SHOW_MS. If show is false, the scene stays hidden until the
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
 *   - The log has the most visits that the local day of now allows. Before
 *     EVENING_HOUR that is MAX_DAYTIME_VISITS. From EVENING_HOUR it is
 *     MAX_VISITS_PER_DAY.
 *   - nextAt is in the future by no more than the longest gap, GAP_MS[1].
 *
 * The new nextAt is a time in GAP_MS after now, or in EVENING_GAP_MS if now is
 * at EVENING_HOUR or later.
 *
 * A log from an earlier day counts as zero visits. A nextAt further away than
 * the longest gap cannot come from this schedule, so the system clock was
 * moved back. It counts as due. Without this rule, a changed system date could
 * silence the scene for days.
 */
export function claimVisit(
  log: VisitLog,
  now: number,
  rnd: () => number = Math.random,
): VisitLog | null {
  const day = dayKey(now);
  const count = log.day === day ? log.count : 0;
  const wait = log.nextAt - now;
  const evening = new Date(now).getHours() >= EVENING_HOUR;
  const cap = evening ? MAX_VISITS_PER_DAY : MAX_DAYTIME_VISITS;
  if (count >= cap || (wait > 0 && wait <= GAP_MS[1])) return null;
  return { day, count: count + 1, nextAt: now + pick(evening ? EVENING_GAP_MS : GAP_MS, rnd) };
}

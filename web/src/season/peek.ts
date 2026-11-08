// chalk-web -- 129-1: the peek schedule. 129-7: the daily cap. 129-9: the
// evening. 129-16: the windows of the neutral scene. 129-24: two visits in
// each window.
//
// Outside the always-on hours (ALWAYS_ON in seasons.ts), the scene is not
// there all the time. It is a visitor, not furniture. A visit
// shows for 45 s to 75 s. Visits of a season scene are few: at most
// MAX_VISITS_PER_DAY in one local calendar day. Before EVENING_HOUR, at most MAX_DAYTIME_VISITS of them
// can start, so a tab that stays open all day does not use up the evening.
// The gap between the starts of two visits is 1 to 2 hours in the daytime and
// 20 to 40 minutes in the evening.
// The neutral scene (a date in no season) does not use this cap or these gaps.
// It has at most NEUTRAL_PLAYS visits in each of the NEUTRAL_WINDOWS, with
// NEUTRAL_GAP_MS between two starts. claimNeutral grants them.
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

/**
 * 129-16: NEUTRAL_WINDOWS are the windows of the neutral scene, as
 * [start, end) in local hours. 129-24: the neutral scene shows at most
 * NEUTRAL_PLAYS times in each window.
 */
export const NEUTRAL_WINDOWS: Range[] = [
  [8, 12],
  [16, 24],
];

/** NEUTRAL_PLAYS is the most neutral visits in one window. */
export const NEUTRAL_PLAYS = 2;

/**
 * NEUTRAL_GAP_MS is the shortest time between the starts of two neutral
 * visits, in milliseconds. It is 20 minutes.
 */
export const NEUTRAL_GAP_MS = 1_200_000;

/**
 * A NeutralLog records the neutral visits of one local calendar day.
 *
 * day is the local date, as made by dayKey. at holds the target time of each
 * slot, NEUTRAL_PLAYS slots for each window in NEUTRAL_WINDOWS, in
 * milliseconds since the epoch. done tells for each slot if its visit started.
 * last is the start of the last neutral visit, or 0 if there is none.
 */
export interface NeutralLog {
  day: string;
  at: number[];
  done: boolean[];
  last: number;
}

/** NeutralClaim is the result of claimNeutral. */
export interface NeutralClaim {
  log: NeutralLog;
  show: boolean;
}

/**
 * claimNeutral returns the log after a check at now, and reports whether a
 * neutral visit starts. It does not change log.
 *
 * A log from another day is replaced. Each window is cut into NEUTRAL_PLAYS
 * equal slots, and the new log has a random target time in each slot, no
 * later than SHOW_MS[1] before the end of the slot. A visit starts if now is in
 * a window, a slot of that window has not started its visit, now is at the
 * target time of that slot or later, and the last visit started at least
 * NEUTRAL_GAP_MS ago. The earliest such slot is used. After the end of a
 * window, its unused slots are lost.
 */
export function claimNeutral(
  log: NeutralLog,
  now: number,
  rnd: () => number = Math.random,
): NeutralClaim {
  const day = dayKey(now);
  const d = new Date(now);
  const at = (h: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() + h * 3_600_000;
  const slots = NEUTRAL_WINDOWS.length * NEUTRAL_PLAYS;
  let next = log;
  if (log.day !== day || log.at.length !== slots || log.done.length !== slots) {
    const at0: number[] = [];
    for (const [a, b] of NEUTRAL_WINDOWS) {
      const part = (b - a) / NEUTRAL_PLAYS;
      for (let k = 0; k < NEUTRAL_PLAYS; k++) at0.push(pick([at(a + k * part), at(a + (k + 1) * part) - SHOW_MS[1]], rnd));
    }
    next = { day, at: at0, done: at0.map(() => false), last: 0 };
  }
  const w = NEUTRAL_WINDOWS.findIndex(([a, b]) => now >= at(a) && now < at(b));
  if (w < 0) return { log: next, show: false };
  const rested = now - next.last >= NEUTRAL_GAP_MS || now < next.last;
  if (!rested) return { log: next, show: false };
  for (let k = 0; k < NEUTRAL_PLAYS; k++) {
    const j = w * NEUTRAL_PLAYS + k;
    if (next.done[j] || now < next.at[j]) continue;
    const done = next.done.slice();
    done[j] = true;
    return { log: { ...next, done, last: now }, show: true };
  }
  return { log: next, show: false };
}

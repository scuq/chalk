// chalk-web -- 129-7: the log of visits, shared by all tabs. 129-15: the last
// row of each key. 129-16: a separate log for the neutral scene. 129-22: a
// row can have a weight. 129-24: the neutral
// log has four slots and the start of the last visit.
//
// A visit of the scene is claimed from a log in localStorage. All tabs and
// reloads of one browser profile read the same log. So the daily cap in
// peek.ts holds for the device and not for the account. If localStorage fails,
// a module variable holds the log, and the cap holds for that page only.
// The neutral scene has its own log, and the cap does not count its visits.
// That log holds four slots, two for each window, and the start of the last
// neutral visit.
// The log of the last rows lets a visit pick a row that differs from the row
// of the last visit. A weight makes some rows more likely than others.

import { claimNeutral, claimVisit, type NeutralLog, type VisitLog } from "./peek";

// The localStorage key of the log. The value is JSON of a VisitLog.
const STORAGE_KEY = "chalk.season.visits.v1";

// The log of this page. It is the fallback if localStorage fails.
let memory: VisitLog = { day: "", count: 0, nextAt: 0 };

// Returns the stored log. If the entry is absent, corrupt, or unreadable,
// returns the log of this page.
function loadLog(): VisitLog {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const log = JSON.parse(raw);
      if (
        typeof log?.day === "string" &&
        Number.isFinite(log.count) &&
        Number.isFinite(log.nextAt)
      ) {
        return log;
      }
    }
  } catch {
    // Storage is not readable. The log of this page is used.
  }
  return memory;
}

/**
 * takeVisit reports whether the caller can show a visit now, and records the
 * visit if it can. It spends one visit of the day and sets the time of the
 * next one. If it returns false, it changes nothing.
 *
 * The caller must call it only for a visible page. A call for a hidden page
 * spends a visit that nobody sees.
 */
export function takeVisit(now: number = Date.now(), neutral = false): boolean {
  if (neutral) return takeNeutral(now);
  const log = claimVisit(loadLog(), now);
  if (!log) return false;
  memory = log;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(log));
  } catch {
    // The write failed. The cap then holds for this page only.
  }
  return true;
}

// 129-15: the localStorage key of the last row of each key. The value is JSON
// of an object from key to row index.
const LAST_KEY = "chalk.season.last.v1";

// The last rows of this page. It is the fallback if localStorage fails.
let lastMemory: Record<string, number> = {};

function loadLast(): Record<string, number> {
  try {
    const raw = window.localStorage.getItem(LAST_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    }
  } catch {
    // Storage is not readable. The rows of this page are used.
  }
  return lastMemory;
}

/**
 * nextRow returns the row index for the next visit of key, and records it.
 * `weights` is a count, or an array with one weight for each row. A count
 * gives each row the weight 1. The index is 0 to the number of rows minus 1.
 * The chance of an index is its weight divided by the sum of the weights. A
 * weight that is not a finite number above 0 counts as 0, so that row never
 * comes. The index is never the index of the last visit of key, unless every
 * other row has the weight 0. If no valid last index is stored, any row with a
 * weight above 0 can come.
 */
export function nextRow(key: string, weights: number | number[], rnd: () => number = Math.random): number {
  // 129-22: a count gives each row the weight 1.
  const w = typeof weights === "number" ? Array.from({ length: weights }, () => 1) : weights.map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const count = w.length;
  const last = loadLast();
  const prev = last[key];
  const valid = Number.isInteger(prev) && prev >= 0 && prev < count;
  const pick = w.map((v, i) => (valid && i === prev ? 0 : v));
  const total = pick.reduce((sum, v) => sum + v, 0);
  const x = rnd();
  const r = Math.min(0.999999, Math.max(0, Number.isFinite(x) ? x : 0));
  let index = total > 0 ? -1 : Math.floor(r * count);
  let target = r * total;
  for (let i = 0; i < count && index < 0; i++) {
    if (pick[i] > 0 && target < pick[i]) index = i;
    target -= pick[i];
  }
  if (index < 0) index = pick.reduce((best, v, i) => (v > 0 ? i : best), 0);
  lastMemory = { ...last, [key]: index };
  try {
    window.localStorage.setItem(LAST_KEY, JSON.stringify(lastMemory));
  } catch {
    // The write failed. The rule then holds for this page only.
  }
  return index;
}

// 129-16: the localStorage key of the neutral log. The value is JSON of a
// NeutralLog.
const NEUTRAL_KEY = "chalk.season.neutral.v1";

// The neutral log of this page. It is the fallback if localStorage fails.
let neutralMemory: NeutralLog = { day: "", at: [], done: [], last: 0 };

function loadNeutral(): NeutralLog {
  try {
    const raw = window.localStorage.getItem(NEUTRAL_KEY);
    if (raw) {
      const log = JSON.parse(raw);
      if (
        typeof log?.day === "string" &&
        Array.isArray(log.at) &&
        Array.isArray(log.done) &&
        log.at.length === log.done.length &&
        log.at.every(Number.isFinite) &&
        log.done.every((v: unknown) => typeof v === "boolean")
      ) {
        // 129-24: a stored log from before the gap rule has no last. It loads with
        // last 0.
        return { ...log, last: Number.isFinite(log.last) ? log.last : 0 };
      }
    }
  } catch {
    // Storage is not readable. The neutral log of this page is used.
  }
  return neutralMemory;
}

function takeNeutral(now: number): boolean {
  const before = loadNeutral();
  const { log, show } = claimNeutral(before, now);
  if (log === before) return false;
  neutralMemory = log;
  try {
    window.localStorage.setItem(NEUTRAL_KEY, JSON.stringify(log));
  } catch {
    // The write failed. The windows then hold for this page only.
  }
  return show;
}

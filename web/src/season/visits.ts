// chalk-web -- 129-7: the log of visits, shared by all tabs. 129-15: the last
// row of each key. 129-16: a separate log for the neutral scene.
//
// A visit of the scene is claimed from a log in localStorage. All tabs and
// reloads of one browser profile read the same log. So the daily cap in
// peek.ts holds for the device and not for the account. If localStorage fails,
// a module variable holds the log, and the cap holds for that page only.
// The neutral scene has its own log, and the cap does not count its visits.
// The log of the last rows lets a visit pick a row that differs from the row
// of the last visit.

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
 * nextRow returns the row index, 0 to count - 1, for the next visit of key,
 * and records it. The index is never the index of the last visit of key. If
 * no valid last index is stored, any index can come.
 */
export function nextRow(key: string, count: number, rnd: () => number = Math.random): number {
  const last = loadLast();
  const prev = last[key];
  const valid = Number.isInteger(prev) && prev >= 0 && prev < count;
  const x = rnd();
  const r = Math.min(0.999999, Math.max(0, Number.isFinite(x) ? x : 0));
  let index: number;
  if (valid && count > 1) {
    index = Math.floor(r * (count - 1));
    if (index >= prev) index++;
  } else {
    index = Math.floor(r * count);
  }
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
let neutralMemory: NeutralLog = { day: "", at: [], done: [] };

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
        return log;
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

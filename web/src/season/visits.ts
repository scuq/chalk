// chalk-web -- 129-7: the log of visits, shared by all tabs.
//
// A visit of the scene is claimed from a log in localStorage. All tabs and
// reloads of one browser profile read the same log. So the daily cap in
// peek.ts holds for the device and not for the account. If localStorage fails,
// a module variable holds the log, and the cap holds for that page only.

import { claimVisit, type VisitLog } from "./peek";

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
export function takeVisit(now: number = Date.now()): boolean {
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

// chalk-web -- 129-1: the season registry.
//
// Which season it is, decided from the reader's local calendar date, year
// after year. Pure: `now` is a parameter the way daymarks.ts takes one, so
// the window logic is tested with a fixed clock and never with a real one.
// Local time on purpose: a season is a date on the reader's own calendar.

export type SeasonId = "halloween" | "christmas";

/** A month-and-day pair, 1-based month, as a person reads a calendar. */
export type MonthDay = [month: number, day: number];

export interface Season {
  id: SeasonId;
  /** first day inside the season */
  from: MonthDay;
  /** last day inside the season, inclusive */
  to: MonthDay;
}

// The window ends on the day after the feast, so the figure is still there
// for the people who read the night's messages in the morning.
export const SEASONS: Season[] = [{ id: "halloween", from: [10, 24], to: [11, 1] }];

function dayKey([month, day]: MonthDay): number {
  return month * 100 + day;
}

/**
 * seasonFor returns the season that holds the local calendar date of `now`,
 * or null when no season does. A window whose end precedes its start wraps the
 * year boundary.
 */
export function seasonFor(now: number | Date, seasons: Season[] = SEASONS): Season | null {
  const d = typeof now === "number" ? new Date(now) : now;
  const k = dayKey([d.getMonth() + 1, d.getDate()]);
  for (const s of seasons) {
    const a = dayKey(s.from);
    const b = dayKey(s.to);
    const inside = a <= b ? k >= a && k <= b : k >= a || k <= b;
    if (inside) return s;
  }
  return null;
}

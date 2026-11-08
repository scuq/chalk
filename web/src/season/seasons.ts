// chalk-web -- 129-1: the season registry. 129-8: the calendar of eight
// seasons. 129-19: the calendar of nine season ids.
//
// The registry decides which season it is from the local calendar date of
// the reader. The decision is pure: `now` is a parameter, as in daymarks.ts,
// so a test uses a fixed clock and never the real one.
// The date is local on purpose: a season is a date on the calendar of the
// reader.
// The rows of SEASONS leave gaps between the seasons, so a date can have no
// season. A gap lasts 21 days, except the gap from 27 December to 30 December,
// which lasts four days. The scene still shows on such a date: it uses the
// neutral scenes of scene.ts. The calendar is written for the Northern
// Hemisphere.
// chalk reads only the local date, so a reader in the Southern Hemisphere gets
// the same calendar.
// ALWAYS_ON lists the hours in which the scene stays up without a break.

export type SeasonId =
  | "new-year"
  | "winterfest"
  | "spring-bloom"
  | "green-season"
  | "midsummer"
  | "harvest-festival"
  | "spooky-season"
  | "late-autumn"
  | "christmas";

/** A month-and-day pair, 1-based month, as a person reads a calendar. */
export type MonthDay = [month: number, day: number];

export interface Window {
  /** first day inside the window */
  from: MonthDay;
  /** last day inside the window, inclusive */
  to: MonthDay;
}

/** A moment on the calendar to the hour: 1-based month, day, 0-23 hour. */
export type MonthDayHour = [month: number, day: number, hour: number];

/**
 * An HourWindow is a span of local hours. If `to` precedes `from`, the span
 * wraps the year boundary.
 */
export interface HourWindow {
  /** the first hour inside the window */
  from: MonthDayHour;
  /** the first hour after the window */
  to: MonthDayHour;
}

/**
 * A Season is one row of the calendar. `from` and `to` come from [Window]. A
 * season can have more than one row, and the rows then share the `id`.
 */
export interface Season extends Window {
  /** the key of the season, also the key of its scene in scene.ts */
  id: SeasonId;
  /** the name of the season for a person, also the label of the scene for a screen reader */
  label: string;
  /** 129-6: the hours of the video-tile frame. Absent means no frame. */
  night?: HourWindow;
}

// The rows run in calendar order. Each gap between two rows lasts 21 days in
// a common year, except the gap from 27 December to 30 December, which lasts
// four days. So chalk is not in a season all year. A date in a gap has no
// season, and the scene uses the neutral scenes. 29 February falls in the gap
// from 8 February to 28 February, so it has no season. One season has two
// rows: new-year crosses the year boundary, so it has 31 December and 1 January.
// The christmas key runs from 1 December to 26 December. It has no night frame.
export const SEASONS: Season[] = [
  { id: "new-year", label: "New Year / Fireworks", from: [1, 1], to: [1, 1] },
  { id: "winterfest", label: "Winterfest", from: [1, 2], to: [2, 7] },
  { id: "spring-bloom", label: "Spring Bloom", from: [3, 1], to: [4, 9] },
  { id: "green-season", label: "Green Season", from: [5, 1], to: [5, 30] },
  { id: "midsummer", label: "Midsummer", from: [6, 21], to: [8, 10] },
  { id: "harvest-festival", label: "Harvest Festival", from: [9, 1], to: [9, 23] },
  {
    id: "spooky-season",
    label: "Spooky Season",
    from: [10, 15],
    to: [11, 5],
    // Halloween night: the video-tile frame runs from 18:00 on 31 October until 03:00 on 1 November.
    night: { from: [10, 31, 18], to: [11, 1, 3] },
  },
  { id: "late-autumn", label: "Late Autumn", from: [11, 27], to: [11, 30] },
  { id: "christmas", label: "Christmas", from: [12, 1], to: [12, 26] },
  { id: "new-year", label: "New Year / Fireworks", from: [12, 31], to: [12, 31] },
];

/**
 * ALWAYS_ON lists the local hours in which the scene stays up without a break.
 * The windows are 20:00 on 24 December until 05:00 on 25 December, and 20:00
 * on 31 December until 05:00 on 1 January. The list is separate from SEASONS
 * because the second window crosses from the 31 December row into the
 * 1 January row. A field on a row would need two copies of it.
 */
export const ALWAYS_ON: HourWindow[] = [
  { from: [12, 24, 20], to: [12, 25, 5] },
  { from: [12, 31, 20], to: [1, 1, 5] },
];

function dayKey([month, day]: MonthDay): number {
  return month * 100 + day;
}

/**
 * inWindow reports whether the local calendar date of `now` lies inside the
 * window. If the end of a window comes before its start, the window wraps
 * the year boundary.
 */
export function inWindow(now: number | Date, w: Window): boolean {
  const d = typeof now === "number" ? new Date(now) : now;
  const k = dayKey([d.getMonth() + 1, d.getDate()]);
  const a = dayKey(w.from);
  const b = dayKey(w.to);
  return a <= b ? k >= a && k <= b : k >= a || k <= b;
}

/**
 * seasonFor returns the season that holds the local calendar date of `now`,
 * or null when no season does. With the default SEASONS a date in a gap
 * returns null. This is a normal result: the caller then shows the neutral
 * scenes.
 */
export function seasonFor(now: number | Date, seasons: Season[] = SEASONS): Season | null {
  for (const s of seasons) {
    if (inWindow(now, s)) return s;
  }
  return null;
}

function hourKey([month, day, hour]: MonthDayHour): number {
  return (month * 100 + day) * 100 + hour;
}

/**
 * inHours reports whether the local time of `now` lies inside the window.
 * The `from` hour is inside. The `to` hour is outside.
 * If `to` precedes `from`, the window wraps the year boundary.
 */
export function inHours(now: number | Date, w: HourWindow): boolean {
  const d = typeof now === "number" ? new Date(now) : now;
  const k = hourKey([d.getMonth() + 1, d.getDate(), d.getHours()]);
  const a = hourKey(w.from);
  const b = hourKey(w.to);
  return a <= b ? k >= a && k < b : k >= a || k < b;
}

/**
 * nightFor reports whether the video-tile frame of the season is on at `now`.
 * A season without `night` always gives false.
 */
export function nightFor(season: Season, now: number | Date): boolean {
  return season.night ? inHours(now, season.night) : false;
}

/**
 * alwaysOn reports whether the local time of `now` lies inside one of the
 * windows. The `from` hour is inside. The `to` hour is outside.
 */
export function alwaysOn(now: number | Date, windows: HourWindow[] = ALWAYS_ON): boolean {
  return windows.some((w) => inHours(now, w));
}

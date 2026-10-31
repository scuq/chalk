// chalk-web -- 129-1: the season registry.
//
// The registry decides which season it is from the local calendar date of
// the reader. The decision is pure: `now` is a parameter, as in daymarks.ts,
// so a test uses a fixed clock and never the real one.
// The date is local on purpose: a season is a date on the calendar of the
// reader.
//
// 129-4/129-5: a season also names its figures. They are the cut-outs in
// assets/season/<id>/, and each visit draws one at random. A season can
// also have an aura window. The window-edge glow then runs only inside it.
// Without an aura window, the glow runs for the whole season.

export type SeasonId = "halloween" | "winter";

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

export interface Season extends Window {
  id: SeasonId;
  /** the figures that visit, by file name under assets/season/<id>/ */
  figures: string[];
  /** the days the window-edge glow runs; absent means the whole season */
  aura?: Window;
  /** 129-6: the hours of the video-tile frame. Absent means no frame. */
  night?: HourWindow;
}

export const SEASONS: Season[] = [
  {
    // The window ends one day after the feast. People who read the night's
    // messages in the morning still see the figure.
    id: "halloween",
    from: [10, 24],
    to: [11, 1],
    figures: [
      "pumpkin",
      "ghost",
      "witch-hat",
      "cauldron",
      "black-cat",
      "skull-candle",
      "bat",
      "spider-web",
      "scarecrow",
      "haunted-lantern",
    ],
    // Halloween night: the video-tile frame runs from 18:00 on 31 October until 03:00 on 1 November.
    night: { from: [10, 31, 18], to: [11, 1, 3] },
  },
  {
    // Winter runs through the holidays into the new year. The glow runs
    // only on the three days of Christmas.
    id: "winter",
    from: [12, 1],
    to: [1, 6],
    figures: [
      "snowflake",
      "snowman",
      "pine-tree",
      "ice-crystal",
      "arctic-fox",
      "winter-lantern",
      "signpost",
      "icicles",
      "scarf",
      "mittens",
    ],
    aura: { from: [12, 23], to: [12, 25] },
  },
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
 * or null when no season does.
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
 * auraFor reports whether the window-edge glow of the season runs on the
 * local calendar date of `now`. A season without an aura window returns true.
 */
export function auraFor(season: Season, now: number | Date): boolean {
  return season.aura ? inWindow(now, season.aura) : true;
}

/**
 * pickFigure returns one figure of the season at random. It never returns
 * `avoid`, unless the season has only one figure. `rnd` returns a number
 * from 0 to 1. The function clamps a number outside that range, and it
 * treats a value that is not finite as 0.
 */
export function pickFigure(
  season: Season,
  rnd: () => number = Math.random,
  avoid?: string,
): string {
  const pool =
    season.figures.length > 1 ? season.figures.filter((f) => f !== avoid) : season.figures;
  const r = rnd();
  const t = Number.isFinite(r) ? Math.min(0.999999, Math.max(0, r)) : 0;
  return pool[Math.floor(t * pool.length)];
}

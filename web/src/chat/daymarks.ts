// chalk-web -- 113-1: day marks in the message feed.
//
// Scrolling back gave you a time and no date (docs/phases/PHASE-113-DAYMARKS.md).
// This decides where a calendar-day boundary falls in a rendered list and what
// to call it. Pure: nothing here touches the DOM or the clock, so `now` is a
// parameter the same way fmtRelative takes one -- MessageList hoists one Date
// per render pass and hands it to both.
//
// Local time is the frame of reference throughout. A message's day is the day
// it was FOR THE READER, so two readers in different timezones can honestly
// disagree about where a boundary falls; re-cutting history around the
// reader's own midnight is the point.

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const WEEKDAYS_SHORT = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

const MONTHS_SHORT = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

// The local calendar day, as a sortable key. Not an ISO instant -- the point is
// that two Dates an hour apart across local midnight get different keys, which
// a UTC-based key would get wrong for most of the world.
export function dayKey(d: Date): string {
  const y = d.getFullYear().toString().padStart(4, "0");
  const m = (d.getMonth() + 1).toString().padStart(2, "0");
  const day = d.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Whole calendar days from `a`'s day to `b`'s day -- positive when b is later.
// Both ends are normalised to local midnight first, so this counts date
// changes rather than 24-hour spans and a DST shift can't turn one day into
// zero or two.
function daysBetween(a: Date, b: Date): number {
  const am = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
  const bm = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
  return Math.round((bm - am) / 86400000);
}

// What to call the day `d` falls on, seen from `now`. Lowercase and
// hand-rolled to match fmtRelative and the rest of chalk's UI text; see the
// phase doc for why this isn't toLocaleDateString.
//
// A future timestamp (clock skew between two clients) falls through to the
// full form rather than claiming "today" or a weekday, which would be a lie
// the reader can't unpick.
export function dayLabel(d: Date, now: Date): string {
  const back = daysBetween(d, now);
  if (back === 0) return "today";
  if (back === 1) return "yesterday";
  if (back > 1 && back < 7) return WEEKDAYS[d.getDay()];
  const base = `${WEEKDAYS_SHORT[d.getDay()]} ${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  // The year is worth a word only when it isn't the current one.
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

// Where the marks go: row index -> label, for a list of timestamps in feed
// order. Empty map for an empty list.
//
// Every boundary between adjacent rows is marked. The FIRST row is marked too
// -- otherwise the top of the loaded window is the one place with no answer --
// EXCEPT when it falls on today, because then there is nothing to say. That
// exception is what keeps a live channel looking exactly as it did before this
// existed: a feed that is entirely today's renders no marks at all.
//
// Out-of-order timestamps (a clock-skewed sender) produce a mark wherever the
// key changes, in both directions. A boundary is a boundary; inventing a
// smoothing rule here would only hide the skew.
export function dayMarkIndices(
  stamps: readonly Date[],
  now: Date,
): Map<number, string> {
  const marks = new Map<number, string>();
  if (stamps.length === 0) return marks;
  const today = dayKey(now);
  if (dayKey(stamps[0]) !== today) marks.set(0, dayLabel(stamps[0], now));
  for (let i = 1; i < stamps.length; i++) {
    if (dayKey(stamps[i]) === dayKey(stamps[i - 1])) continue;
    marks.set(i, dayLabel(stamps[i], now));
  }
  return marks;
}

// 113-2: how far down the scrollport a stuck day mark has to sit to clear
// whatever is pinned over it.
//
// A sticky box's bottom edge, once stuck, is its computed `top` plus its
// border-box height -- and `top` is negative for chalk's channel header, which
// pulls itself up to swallow the pane's padding (theme.css). Taking the
// maximum over every sticky child rather than looking for the header by name
// keeps this working if a second pinned band ever appears above the feed, and
// yields 0 where nothing is pinned at all (the thread panel, the voice
// scratchpad). Never negative: a mark above the top of the scrollport is one
// the reader cannot see.
export function pinnedBottom(
  boxes: readonly { top: number; height: number }[],
): number {
  let bottom = 0;
  for (const b of boxes) bottom = Math.max(bottom, b.top + b.height);
  return bottom;
}

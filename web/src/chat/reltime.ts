// chalk-web -- "2h ago" style timestamps, and "in 2h" style times to come.
//
// Extracted from MessageList in 42-8 so the thread inbox reads times the same
// way the message list does. A second copy would have drifted the first time
// either was tweaked.
//
// fmtRelative formats a time in the past only. 87-4 adds fmtUntil for a time in
// the future, because the Reminders panel shows when a reminder is due.
//
// `now` is a parameter rather than read from the clock so callers can hoist one
// Date per render pass (MessageList already does) and so this stays testable.
export function fmtRelative(d: Date, now: Date): string {
  const sec = Math.floor((now.getTime() - d.getTime()) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 2) return "yesterday";
  if (day < 7) return `${day}d ago`;
  // Older than a week: a short calendar date says more than "23d ago".
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getMonth()]} ${d.getDate()}`;
}

// Lowercase, to match the other labels of the panel. The index is Date.getDay().
const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// The same short month names as fmtRelative. The index is Date.getMonth().
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// fmtUntil returns the time from now until d, in the shortest form that fits.
// The forms, in order:
//
//   - "now" if d is not after now
//   - "in under 1m" for less than one minute
//   - "in Nm" for less than one hour
//   - "in Nh" for less than 24 hours
//   - a lowercase weekday and the 24-hour time, for less than six days
//   - the month, the day, and the 24-hour time
//
// `now` is a parameter for the reason that fmtRelative gives.
export function fmtUntil(d: Date, now: Date): string {
  const sec = Math.floor((d.getTime() - now.getTime()) / 1000);
  if (sec <= 0) return "now";
  if (sec < 60) return "in under 1m";
  const min = Math.floor(sec / 60);
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `in ${hr}h`;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (hr < 24 * 6) return `${WEEKDAYS[d.getDay()]} ${hm}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hm}`;
}

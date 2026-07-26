// chalk-web -- "2h ago" style timestamps.
//
// Extracted from MessageList in 42-8 so the thread inbox reads times the same
// way the message list does. A second copy would have drifted the first time
// either was tweaked.
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

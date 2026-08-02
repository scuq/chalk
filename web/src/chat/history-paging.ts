// 55-1: main-feed scrollback paging. Pure so the sizing and damping rules
// can be tested without a DOM. See docs/PHASE-55-HISTORY.md.

// Every main-feed fetch_history uses this limit. It has to be ONE shared
// constant: the ack doesn't echo the limit, so "did we reach the beginning?"
// is decided by comparing the page against what we always ask for.
export const HISTORY_PAGE_SIZE = 50;

// A short page means the server ran out of rows: the beginning of the
// channel is loaded. (An exactly-full page whose next page would be empty
// stays incomplete until that empty page is fetched -- one spare roundtrip,
// bought cheap: no ack format change.)
export function pageMarksComplete(rowCount: number): boolean {
  return rowCount < HISTORY_PAGE_SIZE;
}

// Auto-fill damping. When the feed is too short to scroll, the sentinel
// stays visible and pages are fetched hands-free -- but a reply-only
// stretch adds zero visible rows per page, and unbounded hands-free
// crawling is how you accidentally download a whole channel. After this
// many consecutive auto-pages that surfaced nothing, auto-fill stops and a
// manual "load older" button takes over (a click resets the streak).
export const AUTO_PAGE_EMPTY_LIMIT = 3;

export function nextEmptyStreak(prev: number, headsAdded: number): number {
  return headsAdded > 0 ? 0 : prev + 1;
}

export function autoPagingAllowed(emptyStreak: number): boolean {
  return emptyStreak < AUTO_PAGE_EMPTY_LIMIT;
}

// Landing auto-fill budget. When the read cursor sits below every loaded
// message -- a channel never opened on this account, or an unread run longer
// than one page -- the divider is the feed's first row, so landing on it
// leaves the sentinel in view. Filling the page above is what the reader
// wants (the first unread with some context over it), but the next page
// leaves the divider on the first row again, and the fill would walk to the
// beginning of the channel hands-free. This bounds it; past the budget the
// manual "load older" button takes over, exactly as the empty-streak damping
// hands over.
export const LANDING_PAGE_LIMIT = 4;

export function landingFillAllowed(pagesFetched: number): boolean {
  return pagesFetched < LANDING_PAGE_LIMIT;
}

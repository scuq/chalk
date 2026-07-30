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

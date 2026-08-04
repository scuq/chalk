// 55-1: main-feed scrollback paging. Pure so the sizing and damping rules
// can be tested without a DOM. See docs/phases/PHASE-55-HISTORY.md.

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

// 76-3: the divider only earns a scroll when the unread run is taller than
// the screen. Coming back from a phone's conversation list re-freezes the
// unread window every time, so a couple of new messages -- which are on
// screen anyway from the bottom -- were enough to land the reader mid-feed
// with the newest message hidden below the fold.
//
// The slack is what keeps a run that is only just too tall from earning a
// scroll for the sake of a line or two.
export const UNREAD_FIT_SLACK_PX = 48;

export function unreadRunFits(runPx: number, viewportPx: number): boolean {
  if (viewportPx <= 0) return false;
  return runPx + UNREAD_FIT_SLACK_PX <= viewportPx;
}

// 79-1: breathing room between the pinned header and the divider it lands
// under. This used to be the divider's `scroll-margin-top` in theme.css, back
// when the landing scrolled it flush to the top of the scrollport.
export const DIVIDER_HEADER_GAP_PX = 12;

// 79-1: how far to move the scroller so the divider lands BELOW the pinned
// channel header rather than behind it.
//
// The header is `position: sticky` INSIDE the feed's scroller (theme.css), so
// the top of the scrollport and the first row the reader can actually see are
// not the same place. Scrolling the divider flush to the top -- which is what
// `scrollIntoView({block: "start"})` does -- tucked it, and its "new messages"
// label, under the bar: the reader landed on the right message with no marker
// and the newest message below the fold, which reads as "it scrolled somewhere
// random" rather than "here is where you left off".
//
// dividerOffset is the divider's top relative to the scrollport's top;
// pinnedInset is the measured height of whatever is pinned over it (0 where
// nothing is, e.g. the thread panel). The result is a delta to add to
// scrollTop; the browser clamps it to the scrollable range.
export function dividerScrollDelta(
  dividerOffset: number,
  pinnedInset: number,
): number {
  return dividerOffset - pinnedInset - DIVIDER_HEADER_GAP_PX;
}

// 79-4: sub-pixel layout puts the same row a fraction of a pixel from where it
// was measured. Correcting that on every resize is churn the reader can't see.
export const KEEP_DRIFT_MIN_PX = 2;

// 79-4: how far to move the scroller to put the row the reader is holding back
// where it was. `recorded` is the offset the row had from the top of the
// scrollport when the reader last scrolled, `current` is where it is now; the
// difference is what late growth ABOVE it (an attachment resolving from its
// "decrypting…" strip to a full-size box) pushed it by. Positive means the row
// moved down and the scroller has to follow it.
//
// Growth BELOW the held row leaves it alone and yields 0, which is why this is
// the whole rule: it does not need to know where the growth happened.
export function keepDrift(recorded: number, current: number): number {
  const drift = current - recorded;
  return Math.abs(drift) < KEEP_DRIFT_MIN_PX ? 0 : drift;
}

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_PAGE_EMPTY_LIMIT,
  HISTORY_PAGE_SIZE,
  LANDING_PAGE_LIMIT,
  autoPagingAllowed,
  UNREAD_FIT_SLACK_PX,
  DIVIDER_HEADER_GAP_PX,
  dividerScrollDelta,
  KEEP_DRIFT_MIN_PX,
  keepDrift,
  landingFillAllowed,
  nextEmptyStreak,
  pageMarksComplete,
  unreadRunFits,
} from "./history-paging";

test("a short page marks the channel complete, a full one doesn't", () => {
  assert.equal(pageMarksComplete(0), true);
  assert.equal(pageMarksComplete(HISTORY_PAGE_SIZE - 1), true);
  assert.equal(pageMarksComplete(HISTORY_PAGE_SIZE), false);
});

test("a page with visible heads resets the empty streak", () => {
  assert.equal(nextEmptyStreak(2, 5), 0);
  assert.equal(nextEmptyStreak(0, 1), 0);
});

test("a heads-free page grows the streak", () => {
  assert.equal(nextEmptyStreak(0, 0), 1);
  assert.equal(nextEmptyStreak(2, 0), 3);
});

test("auto paging stops exactly at the limit", () => {
  assert.equal(autoPagingAllowed(AUTO_PAGE_EMPTY_LIMIT - 1), true);
  assert.equal(autoPagingAllowed(AUTO_PAGE_EMPTY_LIMIT), false);
});

test("the landing gets a page budget, and it runs out", () => {
  assert.equal(landingFillAllowed(0), true);
  assert.equal(landingFillAllowed(LANDING_PAGE_LIMIT - 1), true);
  assert.equal(landingFillAllowed(LANDING_PAGE_LIMIT), false);
  assert.equal(landingFillAllowed(LANDING_PAGE_LIMIT + 10), false);
});

test("the landing budget is smaller than a channel but bigger than a page", () => {
  // Enough to put real context above the divider, few enough that a cursor
  // older than the whole channel cannot pull the reader to its beginning.
  assert.ok(LANDING_PAGE_LIMIT >= 2);
  assert.ok(LANDING_PAGE_LIMIT * HISTORY_PAGE_SIZE <= 500);
});

test("a short unread run is read from the bottom, a tall one is not", () => {
  assert.equal(unreadRunFits(100, 600), true);
  assert.equal(unreadRunFits(900, 600), false);
});

test("the fit leaves the divider clear of the pinned header", () => {
  const viewport = 600;
  assert.equal(unreadRunFits(viewport - UNREAD_FIT_SLACK_PX, viewport), true);
  assert.equal(unreadRunFits(viewport - UNREAD_FIT_SLACK_PX + 1, viewport), false);
  // Exactly filling the viewport is not a fit: the divider would land under
  // the header rather than above the first unread message.
  assert.equal(unreadRunFits(viewport, viewport), false);
});

test("an unmeasurable viewport never counts as a fit", () => {
  // No scroller (tests, jsdom) must not silently turn every landing into
  // "jump to the newest message" and throw the divider away.
  assert.equal(unreadRunFits(0, 0), false);
});

test("the divider lands below the pinned header, not behind it", () => {
  // A divider 900px down the scroller, under a 50px sticky channel header:
  // the scroll has to stop short of putting it at the top of the scrollport,
  // or the bar paints over it and the "new messages" label is never seen.
  const delta = dividerScrollDelta(900, 50);
  assert.equal(delta, 900 - 50 - DIVIDER_HEADER_GAP_PX);
  // The divider ends up this far below the header's bottom edge.
  assert.equal(900 - delta - 50, DIVIDER_HEADER_GAP_PX);
});

test("the gap alone applies where nothing is pinned", () => {
  // The thread panel and the voice scratchpad have no sticky header; the
  // divider still wants a little air above it.
  assert.equal(dividerScrollDelta(900, 0), 900 - DIVIDER_HEADER_GAP_PX);
});

test("a header taller than the divider's offset scrolls backwards, not to it", () => {
  // The divider is already above the header's bottom edge, so reaching it
  // means scrolling UP. A clamp to >= 0 here would leave it behind the bar,
  // which is the bug this rule exists to prevent.
  assert.ok(dividerScrollDelta(20, 50) < 0);
});

test("a row shoved down by growth above it drags the scroller after it", () => {
  // The reader was holding a row 300px into the scrollport. An attachment
  // above them decrypted into a 420px box, so the row is now at 720.
  assert.equal(keepDrift(300, 720), 420);
});

test("growth below the held row moves nothing", () => {
  assert.equal(keepDrift(300, 300), 0);
});

test("a shrink above the held row is corrected the same way", () => {
  // A link preview that fails to render collapses; the row rises, and holding
  // it means scrolling back up by as much.
  assert.equal(keepDrift(300, 120), -180);
});

test("sub-pixel drift is not worth a scroll", () => {
  assert.equal(keepDrift(300, 300.5), 0);
  assert.equal(keepDrift(300, 300 + KEEP_DRIFT_MIN_PX - 0.01), 0);
  assert.equal(keepDrift(300, 300 + KEEP_DRIFT_MIN_PX), KEEP_DRIFT_MIN_PX);
});

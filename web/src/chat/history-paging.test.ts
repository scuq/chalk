import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_PAGE_EMPTY_LIMIT,
  HISTORY_PAGE_SIZE,
  LANDING_PAGE_LIMIT,
  autoPagingAllowed,
  UNREAD_FIT_SLACK_PX,
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

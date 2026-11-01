import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_PAGE_EMPTY_LIMIT,
  HISTORY_PAGE_SIZE,
  LANDING_PAGE_LIMIT,
  autoPagingAllowed,
  UNREAD_FIT_SLACK_PX,
  DIVIDER_HEADER_GAP_PX,
  anchorWatchTargets,
  dividerScrollDelta,
  firstRowBelow,
  KEEP_DRIFT_MIN_PX,
  keepDrift,
  landingFillAllowed,
  landingTarget,
  landingHoldNeeded,
  ANCHOR_SLACK_PX,
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

test("the held landing watches the scrollport, not just the feed", () => {
  // The main feed: the sticky channel header is a sibling of the feed inside
  // the scroller, and the scroller's own height is what the composer shortens
  // from below. Watching the feed alone missed both.
  const feed = "feed";
  const header = "header";
  const scroller = "scroller";
  const targets = anchorWatchTargets(feed, scroller, [header, feed]);
  assert.ok(targets.includes(scroller));
  assert.ok(targets.includes(header));
  assert.ok(targets.includes(feed));
});

test("the thread panel's parent head is watched too", () => {
  // The head is a second message list in the same scroller -- and the one
  // usually carrying the photo, so its late growth is what shoved the replies
  // down after the landing had already run.
  const replies = "replies";
  const targets = anchorWatchTargets(replies, "body", ["parent-head", "divider", replies]);
  assert.ok(targets.includes("parent-head"));
});

test("every box is watched once", () => {
  // The feed is normally among the scroller's children; the caller does real
  // work per target, so it must not appear twice.
  const targets = anchorWatchTargets("feed", "scroller", ["header", "feed"]);
  assert.deepEqual(targets, ["feed", "scroller", "header"]);
});

test("nothing scrolls, nothing else to watch", () => {
  // jsdom and the ephemeral scratchpad have no scrolling ancestor.
  assert.deepEqual(anchorWatchTargets("feed", null, []), ["feed"]);
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

test("the row under the probe line is the held row", () => {
  const rows = [
    { top: 0, bottom: 40 },
    { top: 40, bottom: 90 },
    { top: 90, bottom: 130 },
  ];
  assert.equal(firstRowBelow(rows, 60), 1);
});

test("a probe line in a gap between rows holds the next row down", () => {
  // After a landing, the 12px gap between the pinned header and the divider
  // has no row under the line. A day mark has the same effect. The row that
  // starts below the line is the row the reader sees first.
  const rows = [
    { top: 0, bottom: 40 },
    { top: 52, bottom: 90 },
  ];
  assert.equal(firstRowBelow(rows, 46), 1);
});

test("a probe line below every row holds nothing", () => {
  assert.equal(firstRowBelow([{ top: 0, bottom: 40 }], 41), -1);
});

test("an empty feed holds nothing", () => {
  assert.equal(firstRowBelow([], 10), -1);
});

// 79-8: the target of a first landing, and of a landing again on late rows.
test("a first landing takes the divider only when the run earns it", () => {
  assert.equal(landingTarget(null, true, () => true), "divider");
  assert.equal(landingTarget(null, true, () => false), "end");
  assert.equal(landingTarget(null, false, () => true), "end");
});

test("a re-landing keeps a divider landing", () => {
  const prev = { target: "divider" as const, hadDivider: true };
  assert.equal(landingTarget(prev, true, () => false), "divider");
});

test("a re-landing falls to the end when the divider is gone", () => {
  const prev = { target: "divider" as const, hadDivider: true };
  assert.equal(landingTarget(prev, false, () => true), "end");
});

test("a re-landing keeps the end when the first landing saw a divider", () => {
  const prev = { target: "end" as const, hadDivider: true };
  assert.equal(landingTarget(prev, true, () => true), "end");
});

test("a re-landing decides again when the first landing saw no divider", () => {
  const prev = { target: "end" as const, hadDivider: false };
  assert.equal(landingTarget(prev, true, () => true), "divider");
  assert.equal(landingTarget(prev, true, () => false), "end");
  assert.equal(landingTarget(prev, false, () => true), "end");
});

test("the measurement runs only when the rule needs it", () => {
  let asked = 0;
  const earns = () => { asked++; return true; };
  landingTarget(null, false, earns);
  landingTarget({ target: "divider", hadDivider: true }, true, earns);
  landingTarget({ target: "end", hadDivider: true }, true, earns);
  assert.equal(asked, 0);
  landingTarget(null, true, earns);
  assert.equal(asked, 1);
});

// 79-10: These two tests cover the rule that holds the view on its anchor
// during the landing phase. The rule puts the view back after a write that did
// not take effect, and after a move with no size change.
test("the hold acts only while an anchor is held and the reader has not touched", () => {
  assert.equal(landingHoldNeeded(null, false, 500), false);
  assert.equal(landingHoldNeeded("end", true, 500), false);
  assert.equal(landingHoldNeeded("end", false, 500), true);
  assert.equal(landingHoldNeeded("divider", false, -500), true);
});

test("the hold leaves sub-pixel drift alone", () => {
  assert.equal(landingHoldNeeded("end", false, 0), false);
  assert.equal(landingHoldNeeded("end", false, ANCHOR_SLACK_PX), false);
  assert.equal(landingHoldNeeded("end", false, -ANCHOR_SLACK_PX), false);
  assert.equal(landingHoldNeeded("end", false, ANCHOR_SLACK_PX + 1), true);
});

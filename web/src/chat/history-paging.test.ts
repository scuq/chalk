import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AUTO_PAGE_EMPTY_LIMIT,
  HISTORY_PAGE_SIZE,
  autoPagingAllowed,
  nextEmptyStreak,
  pageMarksComplete,
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

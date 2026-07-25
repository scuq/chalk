import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SIDEBAR_WIDTH_DEFAULT,
  SIDEBAR_WIDTH_MAX,
  SIDEBAR_WIDTH_MIN,
  clampSidebarWidth,
} from "./sidebar-width";
import { selectChatPrefs } from "../state/types";

test("clampSidebarWidth passes an in-range width through", () => {
  assert.equal(clampSidebarWidth(300), 300);
});

test("clampSidebarWidth pins to the bounds", () => {
  assert.equal(clampSidebarWidth(10), SIDEBAR_WIDTH_MIN);
  assert.equal(clampSidebarWidth(9999), SIDEBAR_WIDTH_MAX);
});

test("clampSidebarWidth accepts the bounds themselves", () => {
  assert.equal(clampSidebarWidth(SIDEBAR_WIDTH_MIN), SIDEBAR_WIDTH_MIN);
  assert.equal(clampSidebarWidth(SIDEBAR_WIDTH_MAX), SIDEBAR_WIDTH_MAX);
});

test("clampSidebarWidth rounds fractional widths from pointer math", () => {
  assert.equal(clampSidebarWidth(240.6), 241);
});

test("clampSidebarWidth falls back to the default on junk", () => {
  // A bad pref should look untouched, not pinned to a bound.
  assert.equal(clampSidebarWidth(NaN), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth(Infinity), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth("300"), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth(null), SIDEBAR_WIDTH_DEFAULT);
  assert.equal(clampSidebarWidth(undefined), SIDEBAR_WIDTH_DEFAULT);
});

test("selectChatPrefs defaults sidebarWidth when absent", () => {
  assert.equal(selectChatPrefs(undefined).sidebarWidth, SIDEBAR_WIDTH_DEFAULT);
  assert.equal(selectChatPrefs({}).sidebarWidth, SIDEBAR_WIDTH_DEFAULT);
  assert.equal(selectChatPrefs({ chat: {} }).sidebarWidth, SIDEBAR_WIDTH_DEFAULT);
});

test("selectChatPrefs clamps a stored sidebarWidth", () => {
  assert.equal(selectChatPrefs({ chat: { sidebarWidth: 999 } }).sidebarWidth, SIDEBAR_WIDTH_MAX);
  assert.equal(selectChatPrefs({ chat: { sidebarWidth: 1 } }).sidebarWidth, SIDEBAR_WIDTH_MIN);
  assert.equal(selectChatPrefs({ chat: { sidebarWidth: 280 } }).sidebarWidth, 280);
});

test("selectChatPrefs survives a non-numeric sidebarWidth from an old build", () => {
  const prefs = { chat: { sidebarWidth: "wide" as unknown as number } };
  assert.equal(selectChatPrefs(prefs).sidebarWidth, SIDEBAR_WIDTH_DEFAULT);
});

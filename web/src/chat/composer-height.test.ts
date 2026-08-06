import { test } from "node:test";
import assert from "node:assert/strict";

import {
  COMPOSER_HEIGHT_AUTO,
  COMPOSER_HEIGHT_MAX,
  COMPOSER_HEIGHT_MIN,
  clampComposerDrag,
  clampComposerHeight,
  composerHeightCeiling,
} from "./composer-height";
import { selectChatPrefs } from "../state/types";

test("clampComposerHeight passes an in-range height through", () => {
  assert.equal(clampComposerHeight(200), 200);
});

test("clampComposerHeight pins to the bounds", () => {
  assert.equal(clampComposerHeight(10), COMPOSER_HEIGHT_MIN);
  assert.equal(clampComposerHeight(9999), COMPOSER_HEIGHT_MAX);
});

test("clampComposerHeight rounds fractional heights from pointer math", () => {
  assert.equal(clampComposerHeight(180.6), 181);
});

test("clampComposerHeight reads zero and junk as auto", () => {
  assert.equal(clampComposerHeight(0), COMPOSER_HEIGHT_AUTO);
  assert.equal(clampComposerHeight(-40), COMPOSER_HEIGHT_AUTO);
  assert.equal(clampComposerHeight(NaN), COMPOSER_HEIGHT_AUTO);
  assert.equal(clampComposerHeight(Infinity), COMPOSER_HEIGHT_AUTO);
  assert.equal(clampComposerHeight("200"), COMPOSER_HEIGHT_AUTO);
  assert.equal(clampComposerHeight(null), COMPOSER_HEIGHT_AUTO);
  assert.equal(clampComposerHeight(undefined), COMPOSER_HEIGHT_AUTO);
});

test("composerHeightCeiling is 60% of the viewport, inside the static bounds", () => {
  assert.equal(composerHeightCeiling(1000), 600);
  assert.equal(composerHeightCeiling(800), 480);
  // A very tall window still can't exceed the static maximum.
  assert.equal(composerHeightCeiling(4000), COMPOSER_HEIGHT_MAX);
  // A very short one still leaves a usable field.
  assert.equal(composerHeightCeiling(50), COMPOSER_HEIGHT_MIN);
  assert.equal(composerHeightCeiling(0), COMPOSER_HEIGHT_MAX);
});

test("clampComposerDrag never collapses to auto", () => {
  assert.equal(clampComposerDrag(0, 900), COMPOSER_HEIGHT_MIN);
  assert.equal(clampComposerDrag(-200, 900), COMPOSER_HEIGHT_MIN);
  assert.equal(clampComposerDrag(NaN, 900), COMPOSER_HEIGHT_MIN);
});

test("clampComposerDrag stops at the viewport ceiling", () => {
  assert.equal(clampComposerDrag(900, 800), 480);
  assert.equal(clampComposerDrag(200, 800), 200);
});

test("selectChatPrefs defaults composerHeight to auto when absent", () => {
  assert.equal(selectChatPrefs(undefined).composerHeight, COMPOSER_HEIGHT_AUTO);
  assert.equal(selectChatPrefs({}).composerHeight, COMPOSER_HEIGHT_AUTO);
  assert.equal(selectChatPrefs({ chat: {} }).composerHeight, COMPOSER_HEIGHT_AUTO);
});

test("selectChatPrefs clamps a stored composerHeight", () => {
  assert.equal(selectChatPrefs({ chat: { composerHeight: 9999 } }).composerHeight, COMPOSER_HEIGHT_MAX);
  assert.equal(selectChatPrefs({ chat: { composerHeight: 5 } }).composerHeight, COMPOSER_HEIGHT_MIN);
  assert.equal(selectChatPrefs({ chat: { composerHeight: 220 } }).composerHeight, 220);
});

test("selectChatPrefs survives a non-numeric composerHeight from an old build", () => {
  const prefs = { chat: { composerHeight: "tall" as unknown as number } };
  assert.equal(selectChatPrefs(prefs).composerHeight, COMPOSER_HEIGHT_AUTO);
});

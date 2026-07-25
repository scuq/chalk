// Voice keybinds: the two pure helpers.
//
// The listener itself needs a DOM, but these two decide what the user sees on
// the bind button and whether a keystroke is a shortcut or a letter someone is
// typing -- and getting the latter wrong means binding "M" silently eats every
// M in the composer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isTypingTarget, keyLabel } from "./hotkeys.ts";

test("letter and digit keys read as the character on them", () => {
  assert.equal(keyLabel("KeyM"), "M");
  assert.equal(keyLabel("KeyZ"), "Z");
  assert.equal(keyLabel("Digit4"), "4");
});

test("function keys keep their names", () => {
  assert.equal(keyLabel("F5"), "F5");
  assert.equal(keyLabel("F12"), "F12");
});

test("modifiers say which side they are on", () => {
  assert.equal(keyLabel("ControlLeft"), "left ctrl");
  assert.equal(keyLabel("ShiftRight"), "right shift");
  assert.equal(keyLabel("AltLeft"), "left alt");
});

test("punctuation reads as the symbol, not the code name", () => {
  assert.equal(keyLabel("Backquote"), "`");
  assert.equal(keyLabel("BracketLeft"), "[");
  assert.equal(keyLabel("Slash"), "/");
});

test("an empty binding says so rather than rendering blank", () => {
  assert.equal(keyLabel(""), "unassigned");
});

test("an unrecognised code falls back to itself rather than vanishing", () => {
  assert.equal(keyLabel("MediaTrackPrevious"), "MediaTrackPrevious");
});

const el = (tagName: string, contentEditable = false) =>
  ({ tagName, isContentEditable: contentEditable }) as unknown as EventTarget;

test("text entry counts as typing", () => {
  for (const tag of ["INPUT", "TEXTAREA", "SELECT"]) {
    assert.equal(isTypingTarget(el(tag)), true, tag);
  }
  assert.equal(isTypingTarget(el("input")), true, "lowercase tagName too");
});

test("a contenteditable counts as typing whatever its tag", () => {
  assert.equal(isTypingTarget(el("DIV", true)), true);
  assert.equal(isTypingTarget(el("DIV", false)), false);
});

test("ordinary elements and a missing target are not typing", () => {
  assert.equal(isTypingTarget(el("BUTTON")), false);
  assert.equal(isTypingTarget(el("BODY")), false);
  assert.equal(isTypingTarget(null), false);
  assert.equal(isTypingTarget({} as EventTarget), false, "no tagName at all");
});

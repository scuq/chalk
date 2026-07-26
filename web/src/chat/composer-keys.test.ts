import { test } from "node:test";
import assert from "node:assert/strict";
import {
  composerHelp,
  isMacPlatform,
  matchComposerShortcut,
  shortcutLabel,
  type KeyLike,
} from "./composer-keys";

const key = (over: Partial<KeyLike>): KeyLike => ({
  code: "KeyA",
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

test("ctrl and meta both match", () => {
  assert.equal(matchComposerShortcut(key({ code: "KeyE", ctrlKey: true })), "emoji");
  assert.equal(matchComposerShortcut(key({ code: "KeyE", metaKey: true })), "emoji");
  assert.equal(matchComposerShortcut(key({ code: "KeyG", ctrlKey: true })), "gif");
  assert.equal(
    matchComposerShortcut(key({ code: "KeyF", ctrlKey: true, shiftKey: true })),
    "file",
  );
});

test("no modifier means no shortcut", () => {
  assert.equal(matchComposerShortcut(key({ code: "KeyE" })), null);
});

test("alt is excluded so AltGr typing is safe", () => {
  assert.equal(
    matchComposerShortcut(key({ code: "KeyE", ctrlKey: true, altKey: true })),
    null,
  );
});

test("shift state has to match exactly", () => {
  assert.equal(
    matchComposerShortcut(key({ code: "KeyE", ctrlKey: true, shiftKey: true })),
    null,
  );
  assert.equal(matchComposerShortcut(key({ code: "KeyF", ctrlKey: true })), null);
});

test("unbound keys fall through", () => {
  assert.equal(matchComposerShortcut(key({ code: "KeyZ", ctrlKey: true })), null);
  assert.equal(matchComposerShortcut(key({ code: "Enter", ctrlKey: true })), null);
});

test("labels follow the platform", () => {
  assert.equal(shortcutLabel("emoji", false), "ctrl+e");
  assert.equal(shortcutLabel("emoji", true), "⌘+e");
  assert.equal(shortcutLabel("file", false), "ctrl+shift+f");
});

test("isMacPlatform sniffs the obvious strings", () => {
  assert.equal(isMacPlatform("MacIntel"), true);
  assert.equal(isMacPlatform("iPhone"), true);
  assert.equal(isMacPlatform("Linux x86_64"), false);
  assert.equal(isMacPlatform(""), false);
});

test("the help sheet covers every shortcut and has no blanks", () => {
  const rows = composerHelp(false);
  for (const r of rows) {
    assert.ok(r.keys.length > 0);
    assert.ok(r.what.length > 0);
  }
  for (const action of ["emoji", "gif", "file"] as const) {
    const label = shortcutLabel(action, false);
    assert.ok(rows.some((r) => r.keys === label), `help is missing ${action}`);
  }
});

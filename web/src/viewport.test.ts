// 125-1: the phone shell tracks the visual viewport, asserted against both
// the pure function and the stylesheet.
//
// shellHeight has no DOM dependency and is tested directly. Whether
// theme.css actually reads it back cannot be tested the same way -- jsdom
// has no visualViewport and no keyboard to open -- so, as in
// theme-sidebar.test.ts, the test reads the stylesheet's own declarations
// and checks that the phone rules for html, body and the app shell take
// their height from SHELL_HEIGHT_VAR rather than a bare 100dvh.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { SHELL_HEIGHT_VAR, shellHeight } from "./viewport";

// Comment-stripped, like theme-sidebar.test.ts: a declaration inside a
// comment reads fine in the source and does not exist in the browser.
const css = readFileSync(join(resolve(process.cwd(), "src"), "theme.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

test("shellHeight follows the visual viewport when the keyboard is open", () => {
  assert.equal(shellHeight(420, 1, 844), 420);
  assert.equal(shellHeight(419.6, 1, 844), 420);
});

test("shellHeight never grows past the layout viewport", () => {
  assert.equal(shellHeight(900, 1, 844), 844);
});

test("shellHeight ignores the visual viewport while pinch-zoomed", () => {
  assert.equal(shellHeight(300, 2.5, 844), 844);
});

test("shellHeight falls back to innerHeight on junk", () => {
  assert.equal(shellHeight(undefined, undefined, 844), 844);
  assert.equal(shellHeight(0, 1, 844), 844);
  assert.equal(shellHeight(NaN, 1, 844), 844);
});

test("the phone shell and the page take their height from the variable", () => {
  const use = `height:\\s*var\\(${SHELL_HEIGHT_VAR},\\s*100dvh\\)`;
  assert.match(css, new RegExp(`\\.chalk-app--thread-open\\s*\\{[^}]*${use}`), "phone shell rule");
  assert.match(css, new RegExp(`html,\\s*body\\s*\\{[^}]*min-height:\\s*0;[^}]*${use}`), "phone page rule");
});

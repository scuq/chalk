// 135-4: the phone shell. These assertions read theme.css and index.html as
// text, because the test suite has no layout engine.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const css = readFileSync(join(root, "src", "theme.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const html = readFileSync(join(root, "index.html"), "utf8");

// The body of the last "@media (max-width: 767px)" block in the file.
function lastPhoneBlock(): string {
  const at = css.lastIndexOf("@media (max-width: 767px) {");
  assert.ok(at >= 0, "no phone block");
  return css.slice(at);
}

test("the viewport meta lets the keyboard resize the layout on Chromium", () => {
  assert.match(html, /<meta name="viewport" content="[^"]*interactive-widget=resizes-content[^"]*">/);
  assert.match(html, /<meta name="viewport" content="[^"]*viewport-fit=cover[^"]*">/);
});

test("on the phone the document does not scroll, so there is no pull-to-refresh", () => {
  const m = /html, body \{([^}]*)\}/.exec(css.slice(css.indexOf("height: var(--chalk-shell-h, 100dvh)") - 200));
  assert.ok(m, "no phone html, body rule");
  assert.match(m[1], /overflow:\s*hidden;/);
  assert.match(m[1], /overscroll-behavior:\s*none;/);
});

test("on the phone, muted text takes the dim color and decoration keeps the muted one", () => {
  assert.match(css, /--chalk-fg-deco:\s*var\(--chalk-fg-muted\);/);
  assert.match(css, /\.chalk-app \{\s*--chalk-fg-muted:\s*var\(--chalk-fg-dim\);\s*\}/);
  // No border, background, or other decoration reads the muted color directly.
  const direct = [...css.matchAll(/^\s*(border[\w-]*|background|scrollbar-color|text-decoration-color|--voice-on-video-line)\s*:[^;]*var\(--chalk-fg-muted\)/gm)];
  assert.deepEqual(direct.map((m) => m[0].trim()), []);
});

test("the last phone block gives the header, channel header and dialog controls 44px", () => {
  const block = lastPhoneBlock();
  for (const sel of [".chalk-presence-trigger", ".chalk-status-menu-trigger", ".chalk-channel-search", ".chalk-mode-badge", ".chalk-enc-indicator", ".chalk-button"]) {
    assert.ok(block.includes(sel), `${sel} is not in the last phone block`);
  }
  assert.match(block, /min-height:\s*44px;/);
});

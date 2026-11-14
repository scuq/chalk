// 135-4, 137-5, and 137-7: the phone shell, the headers, and the list and chat
// slide. These assertions read theme.css, index.html, and the components as
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

// An indented rule, as it sits inside a media block.
function phoneRule(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`\\n  ${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `no indented "${selector} { ... }" rule`);
  return m[1];
}

test("the phone header stays one row, and a long name gives way before the brand", () => {
  const header = phoneRule(".chalk-header");
  assert.match(header, /flex-wrap:\s*nowrap;/);
  // The header is a grid item of .chalk-app. Without min-width: 0 its
  // automatic minimum width is the sum of what its children need. The grid
  // then widens the column, and the name does not shrink.
  assert.match(header, /min-width:\s*0;/);
  assert.match(phoneRule(".chalk-header-left"), /flex:\s*0 0 auto;/);
  assert.match(phoneRule(".chalk-status"), /min-width:\s*0;/);
  assert.match(phoneRule(".chalk-status-menu-trigger"), /min-width:\s*0;/);
  const name = phoneRule(".chalk-status-menu-name");
  assert.match(name, /overflow:\s*hidden;/);
  assert.match(name, /text-overflow:\s*ellipsis;/);
  const bar = readFileSync(join(root, "src", "components", "StatusBar.tsx"), "utf8");
  assert.match(bar, /<span class="chalk-status-menu-name">you \(\{displayName \?\? "—"\}\)<\/span> ▾/);
});

test("in the channel header only the name shrinks, and search is an icon on the phone", () => {
  assert.match(phoneRule(".chalk-channel-header-name"), /flex:\s*1 1 auto;/);
  assert.match(phoneRule(".chalk-channel-header > :not(.chalk-channel-header-name)"), /flex-shrink:\s*0;/);
  const app = readFileSync(join(root, "src", "components", "App.tsx"), "utf8");
  assert.match(app, /\{isMobile \? <SearchIcon \/> : "search"\}/);
});

test("the chat and the list slide in on the duration token, so reduced motion stops them", () => {
  assert.match(
    phoneRule(".chalk-app--zucker:not(.chalk-app--zucker-list) .chalk-main,\n  .chalk-app--zucker:not(.chalk-app--zucker-list) .chalk-footer-main"),
    /animation:\s*chalk-phone-chat-in var\(--chalk-dur\) ease-out;/,
  );
  assert.match(
    phoneRule(".chalk-app--zucker-list:not(.chalk-app--back-by-swipe) .chalk-phone-list"),
    /animation:\s*chalk-phone-list-in var\(--chalk-dur\) ease-out;/,
  );
  // A transform at rest would move the anchor of the fixed message menu, so
  // the slide exists only inside the keyframes and ends with the animation.
  for (const name of ["chalk-phone-chat-in", "chalk-phone-list-in"]) {
    const m = new RegExp(`@keyframes ${name} \\{\\s*from \\{([^}]*)\\}\\s*\\}`).exec(css);
    assert.ok(m, `no ${name} keyframes with a single from step`);
    assert.match(m[1], /opacity:\s*0;/);
  }
  assert.doesNotMatch(css, /animation-fill-mode|chalk-phone-(chat|list)-in[^;]*\bforwards\b/);
});

test("only a completed swipe marks the way back, and entering a chat clears the mark", () => {
  const app = readFileSync(join(root, "src", "components", "App.tsx"), "utf8");
  assert.match(app, /useSwipeBack\(\s*zuckerActive && zuckerScreen === "chat",\s*swipeBackToList,\s*\)/);
  assert.match(app, /if \(zuckerScreen === "chat"\) setBackBySwipe\(false\);/);
  assert.equal(app.match(/setBackBySwipe\(true\)/g)?.length, 1);
  assert.match(app, /backBySwipe \? "chalk-app--back-by-swipe" : ""/);
});

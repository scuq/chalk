// 123-1: how the sidebar divides its height, asserted against the stylesheet.
//
// The sidebar is a flex column of sections and the voice dock. On a short
// window the column is overfull, and which section gives way decides if
// the channel list is still there. jsdom has no layout, so nothing in
// test.mjs can measure that. The test can only check that the declarations
// match what they must be. The measurements behind them are in
// docs/phases/PHASE-123-SIDEBARFLOOR.md.
//
// 131-2: the dock's call preview is gone. The call rail, a column of its
// own left of the sidebar, shows the participants instead. The third test
// holds the rail's declarations and makes sure the preview does not return.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const THEME_CSS = join(resolve(process.cwd(), "src"), "theme.css");
// Comment-stripped, like theme-voice-pane.test.ts: a declaration inside a
// comment reads fine in the source and does not exist in the browser.
const css = readFileSync(THEME_CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The declaration block of the first rule with exactly this selector, in `src`. */
function blockIn(src: string, selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[};])\\s*${esc}\\s*\\{([^}]*)\\}`).exec(src);
  assert.ok(m, `no parsable "${selector} { ... }" rule`);
  return m[1];
}

const block = (selector: string) => blockIn(css, selector);

/** The flex shorthand of a block as [grow, shrink, basis]. */
function flexOf(decls: string, selector: string): [string, string, string] {
  const flex = /flex:\s*([^;]+);/.exec(decls);
  assert.ok(flex, `${selector} declares no flex shorthand`);
  const parts = flex[1].trim().split(/\s+/);
  assert.equal(parts.length, 3, `${selector} must spell out grow, shrink and basis`);
  return parts as [string, string, string];
}

test("the friends and voice sections give way when the column is overfull", () => {
  for (const sel of [".chalk-sidebar-section--friends", ".chalk-sidebar-section--voice"]) {
    const decls = block(sel);
    const [grow, shrink, basis] = flexOf(decls, sel);
    assert.equal(grow, "0", `${sel} must not grow past its content`);
    // The whole point. flex-shrink: 0 made channels the only shrinkable
    // section, and it shrank to nothing.
    assert.equal(shrink, "1", `${sel} must be shrinkable`);
    assert.equal(basis, "auto", `${sel} still sizes to its content`);
    // A shrinkable section needs a floor. Without one, a long friends list
    // on a short window shrinks the voice section to its border.
    assert.match(decls, /min-height:\s*[1-9][\d.]*em/, `${sel} needs a floor in em`);
    // The caps make sure no section takes the whole column on a tall window.
    assert.match(decls, /max-height:\s*\d+vh/, `${sel} keeps its viewport cap`);
  }
});

test("the channels section keeps a floor", () => {
  const decls = block(".chalk-sidebar-section--channels");
  assert.match(decls, /flex:\s*1;/, "channels still fills what the others leave");
  // min-height: 0 was the bug. It let the list vanish.
  assert.match(decls, /min-height:\s*[1-9][\d.]*em/, "channels needs a floor in em");
});

test("the call rail is a narrow scrolling column, and the dock preview is gone", () => {
  // The token the grid and the footer share.
  assert.match(css, /--chalk-rail-w:\s*48px;/, "theme.css declares --chalk-rail-w");

  const grid = block(".chalk-app--phase08b.chalk-app--rail");
  assert.match(
    grid,
    /grid-template-columns:\s*var\(--chalk-rail-w/,
    "the rail is the first grid column",
  );

  const tilesBox = block(".chalk-call-rail-tiles");
  assert.match(tilesBox, /overflow-y:\s*auto;/, "the tiles scroll when they overflow");
  assert.match(tilesBox, /scrollbar-width:\s*none;/, "the tile column hides its scrollbar");
  // 131-6: the foot with mute and deafen does not scroll with the tiles, and
  // its buttons are shorter than a tile.
  const foot = block(".chalk-call-rail-foot");
  assert.match(foot, /flex:\s*0 0 auto;/, "the foot keeps its height");
  const btn = block(".chalk-call-rail-btn");
  assert.match(btn, /width:\s*40px;/, "a foot button is as wide as a tile");
  assert.match(btn, /height:\s*24px;/, "a foot button is shorter than a tile");

  const tile = block(".chalk-call-tile");
  assert.match(tile, /width:\s*40px;/, "a tile is 40px wide");
  assert.match(tile, /height:\s*40px;/, "a tile is 40px tall");

  // The preview the rail replaced. Its 44px strip was the only max-height
  // media query in the file, so none must remain.
  assert.equal(/\.chalk-voice-pip\b/.test(css), false, "no .chalk-voice-pip rule remains");
  assert.equal(/@media\s*\(max-height/.test(css), false, "no max-height media query remains");

  // 131-7: the sidebar and the rail run to the bottom of the window. The
  // footer spans the main column only, as one column of its own.
  assert.match(block(".chalk-app--phase08b"), /"sidebar\s+main"\s*"sidebar\s+footer"/, "the sidebar spans the footer row");
  assert.match(grid, /"rail\s+sidebar\s+main"\s*"rail\s+sidebar\s+footer"/, "the rail spans the footer row");
  assert.match(block(".chalk-app--phase08b.chalk-app--thread-open"), /"sidebar\s+footer\s+thread"/, "with a thread open too");
  assert.match(block(".chalk-app--phase08b.chalk-app--rail.chalk-app--thread-open"), /"rail\s+sidebar\s+footer\s+thread"/, "with the rail and a thread");
  const footer = block(".chalk-footer");
  assert.match(footer, /grid-template-columns:\s*1fr;/, "the footer is one column");
  assert.doesNotMatch(footer, /--chalk-sidebar-w/, "the footer no longer reserves a sidebar column");
  assert.match(block(".chalk-call-rail-head"), /flex:\s*0 0 auto;/, "the head keeps its height");
  assert.match(block(".chalk-call-rail-btn--leave,\n.chalk-call-rail-btn--leave:hover"), /var\(--chalk-error\)/, "leave is in the error color");
  assert.equal(/\.chalk-voice-controls--rail\b/.test(css), false, "no three-column footer bar remains");
});

test("a voice room with people in it shows a slow red record light (131-4)", () => {
  const live = block(".chalk-chglyph--live,\n.chalk-sidebar-item--active .chalk-chglyph--live");
  assert.match(live, /color:\s*var\(--chalk-error\)/, "the light is red");
  const anim = /animation:\s*chalk-rec-blink\s+([\d.]+)s/.exec(live);
  assert.ok(anim, "the light blinks with the chalk-rec-blink keyframes");
  // Slow: a record light that flashes reads as an alarm.
  assert.ok(Number(anim[1]) >= 1.5, `a cycle of ${anim[1]}s is too fast`);
  assert.match(css, /@keyframes chalk-rec-blink\s*\{/, "the keyframes exist");
  const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.chalk-chglyph--live\s*\{([^}]*)\}/.exec(css);
  assert.ok(reduced, "reduced motion has a rule for the light");
  assert.match(reduced[1], /animation:\s*none/, "reduced motion holds the light steady");
});

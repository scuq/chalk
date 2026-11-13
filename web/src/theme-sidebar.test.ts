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
//
// 134-2: the last test holds the chaos-row declarations. The group tag
// shrinks before the channel name, and the name rule grows into free space.

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

test("132: friend rows are compact, and the list can be a two-column grid", () => {
  const row = block(".chalk-sidebar-item--friend");
  // 132-1: 3px above and below, the base 8px left and right.
  assert.match(row, /padding:\s*3px var\(--chalk-s2\);/, "the friend row has 3px vertical padding");

  // 132-2: auto-fill against the longest row, floored at half the list so
  // the grid never has more than two columns.
  const grid = block(".chalk-sidebar-list--friends.chalk-sidebar-list--columns");
  assert.match(grid, /display:\s*grid;/, "the columns list is a grid");
  assert.match(
    grid,
    /grid-template-columns:\s*repeat\(auto-fill,\s*minmax\(max\(var\(--chalk-friend-col[^)]*\),\s*50%\),\s*1fr\)\)/,
    "the columns come from auto-fill with a 50% floor",
  );
  assert.match(
    block(".chalk-sidebar-list--columns .chalk-sidebar-item--friend"),
    /min-width:\s*0;/,
    "a grid cell lets the name ellipsis hold",
  );
  assert.match(
    block(".chalk-sidebar-list--columns .chalk-sidebar-empty"),
    /grid-column:\s*1 \/ -1;/,
    "the empty state spans both columns",
  );
});

test("132-3: unread is a filled envelope in a theme token, and sits at the right edge of every row", () => {
  // The default theme has its own green. Every other theme derives the color.
  assert.match(css, /--chalk-unread:\s*#24f077;/, "the default theme's unread green");
  assert.match(block("[data-theme]"), /--chalk-unread:\s*var\(--chalk-fg\);/, "other themes derive it");
  assert.match(css, /--chalk-unread-mention:\s*var\(--chalk-accent\);/, "a mention follows the accent");
  const glyph = block(".chalk-unread-dot::before");
  assert.match(glyph, /background:\s*var\(--chalk-unread\);/, "the glyph color is only the token");
  assert.match(glyph, /(^|[;\s])mask:\s*url\("data:image\/svg\+xml/, "the glyph is a mask");
  assert.match(glyph, /M5\.5 8\.5L12 13\.5L18\.5 8\.5/, "the flap is cut out of the envelope");
  assert.doesNotMatch(block(".chalk-unread-dot"), /border-radius:\s*50%/, "the glyph is not a round dot");
  // The glow sits on the element, the mask on its ::before, so the mask
  // does not clip the glow.
  assert.match(block(".chalk-unread-dot--mention"), /filter:\s*drop-shadow\(/, "a mention glows");
  assert.match(
    block(".chalk-unread-dot--mention::before"),
    /background:\s*var\(--chalk-unread-mention\);/,
    "a mention uses its own token",
  );
  // 132-3: every row, friend or channel, pins the glyph to its right edge.
  // In the friend grid that is the edge of the cell, so the envelopes in a
  // column line up.
  assert.match(block(".chalk-unread-dot"), /margin-left:\s*auto;/, "the glyph sits at the row's end");
  assert.equal(
    /\.chalk-sidebar-item--friend\s+\.chalk-unread-dot\s*\{/.test(css),
    false,
    "no friend-row rule moves the glyph from the right edge",
  );
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
  // 131-6, 131-12: the foot with mute and deafen does not scroll with the
  // tiles, and its buttons are as large as a tile.
  const foot = block(".chalk-call-rail-foot");
  assert.match(foot, /flex:\s*0 0 auto;/, "the foot keeps its height");
  const btn = block(".chalk-call-rail-btn");
  assert.match(btn, /width:\s*40px;/, "a foot button is as wide as a tile");
  assert.match(btn, /height:\s*40px;/, "a foot button is as tall as a tile");

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
  const leave = block(".chalk-call-rail-btn.chalk-call-rail-btn--leave,\n.chalk-call-rail-btn.chalk-call-rail-btn--leave:hover");
  assert.match(leave, /background:\s*var\(--chalk-error\)/, "leave is a red button");
  assert.match(leave, /color:\s*#fff;/, "with a white handset");
  assert.equal(/\.chalk-voice-controls--rail\b/.test(css), false, "no three-column footer bar remains");
});

test("a voice room with people in it shows a blinking red LIVE light (131-4, 131-8, 131-9, 131-11)", () => {
  const live = block(".chalk-chglyph--live,\n.chalk-sidebar-item--active .chalk-chglyph--live");
  assert.match(live, /color:\s*var\(--chalk-error\)/, "the light is red, on the active row too");
  const rec = block(".chalk-rec");
  assert.match(rec, /color:\s*var\(--chalk-error\)/, "the indicator is red");
  const dot = block(".chalk-rec-dot");
  const anim = /animation:\s*chalk-rec-blink\s+([\d.]+)s/.exec(dot);
  assert.ok(anim, "the dot blinks with the chalk-rec-blink keyframes");
  // 131-8: a hard on-off blink, like a camera's record light, about one
  // cycle a second. A fade would read as breathing, a faster flash as an alarm.
  assert.ok(Number(anim[1]) >= 1 && Number(anim[1]) <= 2, `a cycle of ${anim[1]}s is off`);
  assert.match(dot, /chalk-rec-blink[^;]*steps\(1,\s*end\)/, "the blink is stepped, not faded");
  const frames = /@keyframes chalk-rec-blink\s*\{([^}]*\}[^}]*\})/.exec(css);
  assert.ok(frames && /opacity:\s*0;/.test(frames[1]), "the dot goes fully dark on the off half");
  // 131-9: The word REC does not blink, and reduced motion holds the dot.
  assert.doesNotMatch(block(".chalk-rec"), /animation:/, "the word stays");
  const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.chalk-rec-dot\s*\{([^}]*)\}/.exec(css);
  assert.ok(reduced, "reduced motion has a rule for the dot");
  assert.match(reduced[1], /animation:\s*none/, "reduced motion holds the dot steady");
});

test("the selected row is one rule on the derived tokens, with no per-theme copies", () => {
  const active = block(".chalk-sidebar-item--active");
  assert.match(active, /background:\s*var\(--chalk-bg-selected\)/, "the fill is the selected token");
  assert.match(active, /box-shadow:\s*inset 0 0 0 1px var\(--chalk-border-strong\)/, "the edge is an inset ring");
  assert.doesNotMatch(active, /border-left/, "the 2px left bar is gone");
  assert.doesNotMatch(
    css,
    /\[data-theme="[\w-]+"\]\s*\.chalk-sidebar-item--active\s*\{/,
    "a theme changes the selected row through --chalk-bg-selected in its palette block",
  );
});

test("unread rows, a live share and keyboard focus each have a visible state", () => {
  assert.match(block(".chalk-sidebar-item--unread .chalk-sidebar-item-name"), /font-weight:\s*700/);
  const share = block(".chalk-call-rail-btn.is-on");
  assert.match(share, /color:\s*var\(--chalk-warn\)/, "screen share on the rail is marked like the dock");
  const focus = block(":where(button, a, input, textarea, select, summary, [tabindex]):focus-visible");
  assert.match(focus, /outline:\s*2px solid var\(--chalk-focus\)/);
  // A media query adds no specificity, so the guard must follow the animation rule to win.
  const guard = /\.chalk-status-dot--connecting \{[^}]*animation:\s*chalk-pulse[^}]*\}\s*@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.chalk-status-dot--connecting\s*\{\s*animation:\s*none/.exec(css);
  assert.ok(guard, "the connecting pulse stops under reduced motion, in a rule after the animation");
});

// 134-2: jsdom has no layout, so the test checks the declarations.
test("in chaos mode the group tag shortens before the channel name does", () => {
  const name = ".chalk-sidebar-item--chaos .chalk-sidebar-item-name";
  const [grow, shrink] = flexOf(block(name), name);
  assert.equal(grow, "1", "the name must take the free space");
  assert.equal(shrink, "1");

  const tag = ".chalk-sidebar-item-tag--group";
  const decls = block(tag);
  const [, tagShrink] = flexOf(decls, tag);
  assert.ok(Number(tagShrink) >= 100, "the tag must shrink far faster than the name");
  assert.match(decls, /min-width:\s*3\.2em/, "the tag keeps about three letters");
  assert.match(decls, /text-overflow:\s*ellipsis/);
  assert.match(decls, /overflow:\s*hidden/);
  assert.match(decls, /white-space:\s*nowrap/);

  // The chaos rule must come after the general name rule, which it overrides
  // at the same specificity.
  assert.ok(
    css.indexOf(name) > css.indexOf(".chalk-sidebar-item-row .chalk-sidebar-item-name"),
    "the chaos name rule must follow the row name rule",
  );
});

// 45-8: how the voice pane divides its height, asserted against the stylesheet.
//
// The voice pane is the one column in chalk that does not scroll: a call panel
// of a size the browser derives from video aspect ratios, a scratchpad that
// takes the rest, and a composer that must stay on screen. Two declarations
// hold that together, and both fail silently and only on a real layout -- the
// pane still renders, it just gives the call's height away or paints the
// control bar across somebody's face. jsdom has no layout, so nothing in
// test.mjs can catch a regression by measuring; what it CAN do is hold the two
// declarations to what they have to be. The measurements behind them are in
// docs/phases/PHASE-45-SCRATCHPAD.md.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const THEME_CSS = join(resolve(process.cwd(), "src"), "theme.css");
// Comment-stripped for the same reason theme-fonts.test.ts strips: a
// declaration stranded inside a comment reads fine in the source and does
// not exist in the browser.
const css = readFileSync(THEME_CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * The declaration block of the rule with exactly this selector.
 *
 * Anchored on the end of the previous rule, because both selectors below are
 * also SUFFIXES of longer ones -- the 63-1 crowded override ends in
 * `.chalk-messages--ephemeral` too -- and a plain indexOf lands in whichever
 * comes first in the file, which is the override.
 */
function block(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[};])\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `theme.css has no parsable "${selector} { ... }" rule`);
  return m[1];
}

test("the scratchpad feed bids for no height of its own", () => {
  const decls = block(".chalk-messages--ephemeral");
  const flex = /flex:\s*([^;]+);/.exec(decls);
  assert.ok(flex, ".chalk-messages--ephemeral declares no flex");
  const [grow, shrink, basis] = flex[1].trim().split(/\s+/);
  assert.equal(grow, "1", "the feed still fills what the call leaves over");
  assert.equal(shrink, "1", "the feed is still the first thing to give way");
  // The whole point. `auto` resolves to the feed's own content height, and a
  // long call's scratchpad is taller than the call panel -- flex then splits
  // the deficit between them and the call shrinks, clipping its bottom row of
  // faces and its control bar. Sixty rows took a 545px panel down to 208px.
  assert.equal(
    basis,
    "0",
    "flex-basis must be 0: `auto` lets scratchpad text bid its own height " +
      "against the call panel, and the call loses the split",
  );
});

test("the scratchpad feed keeps a floor", () => {
  // Basis 0 means the feed is sized entirely by what is left, so without this
  // a tall call would take all of it and there would be nowhere to read.
  assert.match(block(".chalk-messages--ephemeral"), /min-height:\s*6em/);
});

test("the call stage clips instead of spilling over its controls", () => {
  const decls = block(".chalk-main--voice .chalk-voice-stage");
  assert.match(decls, /min-height:\s*0/, "the stage must be shrinkable");
  // The tiles size themselves from their width through aspect-ratio, so
  // shrinking the stage does not shrink the grid inside it: the rows spill
  // out the bottom, and everything laid out after the stage -- the control
  // bar, the scratchpad rule -- lands on top of them.
  assert.match(
    decls,
    /overflow:\s*hidden/,
    "the stage must clip: its grid cannot shrink with it, and the overflow " +
      "is painted under the control bar",
  );
});

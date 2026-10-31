// 129-1: the seam between the seasonal figure and its stylesheet, on the
// theme-flair.test.ts pattern.
//
// Two things nothing else would notice if they broke: a seasonal animation or
// transition that the reduced-motion block forgot, and the section drifting
// below the flair section -- theme-flair.test.ts takes the sheet's last
// reduced-motion block as flair's, so a seasonal block after it would make
// that test read the wrong block.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const css = readFileSync(join(resolve(process.cwd(), "src"), "theme.css"), "utf8");
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

const start = css.indexOf("Phase 129: seasonal");
const flairStart = css.indexOf("Phase 115: flair");
assert.ok(start > 0, "the seasonal section banner comment is gone");
assert.ok(flairStart > 0, "the flair section banner comment is gone");

test("the seasonal section sits above the flair section", () => {
  assert.ok(start < flairStart, "the seasonal section must precede flair");
});

const section = css.slice(start, flairStart).replace(/\/\*[\s\S]*?\*\//g, "");
const rmAt = section.lastIndexOf("@media (prefers-reduced-motion: reduce)");
assert.ok(rmAt > 0, "the seasonal section has no reduced-motion block");
const reduced = section.slice(rmAt).replace(/\s+/g, " ");
const animated = section.slice(0, rmAt);

// Every `selector { ... }` rule in the animated half that declares an
// animation or a transition, as its selector text with whitespace collapsed.
function movingSelectors(text: string): string[] {
  const out: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of text.matchAll(rule)) {
    const sel = m[1].trim().replace(/\s+/g, " ");
    if (sel.startsWith("@") || /^\d/.test(sel) || sel === "to" || sel === "from") continue;
    if (/(animation|transition)\s*:/.test(m[2])) out.push(sel);
  }
  return out;
}

test("every moving seasonal selector is switched off under reduced motion", () => {
  const sels = movingSelectors(animated);
  assert.ok(sels.length >= 2, `expected the fade and the bob, found ${sels.length} moving rules`);
  assert.ok(/animation\s*:\s*none/.test(reduced), "the reduced-motion block sets no animation: none");
  assert.ok(/transition\s*:\s*none/.test(reduced), "the reduced-motion block sets no transition: none");
  for (const sel of sels) {
    assert.ok(reduced.includes(sel), `reduced motion does not cover: ${sel}`);
  }
});

test("no seasonal rule lives outside the seasonal section", () => {
  const before = stripped.slice(0, stripped.indexOf(".chalk-season {"));
  const after = stripped.slice(stripped.indexOf(".chalk-profile-flair-threshold"));
  assert.ok(!/chalk-season/.test(before), "a chalk-season rule lives above the seasonal section");
  assert.ok(!/chalk-season/.test(after), "a chalk-season rule lives below the seasonal section");
});

test("the aura covers the window, takes no clicks, and paints only its edge", () => {
  const aura = /\.chalk-season-aura\s*\{([^}]*)\}/.exec(animated);
  assert.ok(aura, "no .chalk-season-aura rule");
  assert.match(aura![1], /position\s*:\s*fixed/);
  assert.match(aura![1], /inset\s*:\s*0/);
  assert.match(aura![1], /pointer-events\s*:\s*none/);
  assert.match(aura![1], /box-shadow\s*:[^;]*inset/);
  assert.ok(!/background\s*:/.test(aura![1]), "the aura must not fill the window");
  // Every season in the registry sets its aura colour.
  assert.match(animated, /\.chalk-season-aura\[data-season="halloween"\]\s*\{[^}]*--chalk-season-aura\s*:/);
});

test("the anchor takes no room and no clicks, and hangs off the footer's top edge", () => {
  const anchor = /\.chalk-season\s*\{([^}]*)\}/.exec(animated);
  assert.ok(anchor, "no .chalk-season rule");
  assert.match(anchor![1], /height\s*:\s*0/);
  assert.match(anchor![1], /width\s*:\s*0/);
  assert.match(anchor![1], /pointer-events\s*:\s*none/);
  assert.match(anchor![1], /position\s*:\s*absolute/);
  assert.match(anchor![1], /bottom\s*:\s*100%/);
  // The footer is the positioned box it hangs from (91-1 made it so).
  const footer = /(?:^|\n)\.chalk-footer\s*\{([^}]*)\}/.exec(stripped);
  assert.ok(footer && /position\s*:\s*relative/.test(footer[1]), "the footer is no longer positioned");
});

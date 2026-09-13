// 123-1: how the sidebar divides its height, asserted against the stylesheet.
//
// The sidebar is a flex column of sections and the voice dock. On a short
// window the column is overfull, and which section gives way decides if
// the channel list is still there. jsdom has no layout, so nothing in
// test.mjs can measure that. The test can only check that the declarations
// match what they must be. The measurements behind them are in
// docs/phases/PHASE-123-SIDEBARFLOOR.md.

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

test("the call preview is a strip on a short window", () => {
  const base = block(".chalk-voice-pip");
  const baseMax = /max-height:\s*(\d+)px/.exec(base);
  assert.ok(baseMax, ".chalk-voice-pip declares no max-height in px");

  const media = /@media\s*\(max-height:\s*(\d+)px\)\s*\{([\s\S]*?)\n\}/.exec(css);
  assert.ok(media, "theme.css has no max-height media query");
  const threshold = Number(media[1]);
  // A 13-inch laptop viewport under browser chrome is 700px to 780px. A
  // 1440x900 screen is about 800px. A 1080p desktop must stay untouched.
  assert.ok(threshold >= 800 && threshold < 1000, `threshold ${threshold}px covers the laptops and not a desktop`);

  const strip = blockIn(media[2], ".chalk-voice-pip");
  const stripMax = /max-height:\s*(\d+)px/.exec(strip);
  assert.ok(stripMax, "the media query does not cap .chalk-voice-pip");
  assert.ok(
    Number(stripMax[1]) < Number(baseMax[1]),
    `the strip (${stripMax[1]}px) must be shorter than the box (${baseMax[1]}px)`,
  );
  // The monogram fallback is 28px * font-scale. A strip that cannot hold it
  // shows a clipped letter in every audio-only call.
  assert.ok(Number(stripMax[1]) >= 36, "the strip must still hold the monogram");
});

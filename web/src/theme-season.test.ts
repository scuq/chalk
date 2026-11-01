// 129-1: the seam between the seasonal scene and its stylesheet, on the
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
import { SEASONS } from "./season/seasons";

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
  assert.ok(sels.length >= 1, `expected the fade, found ${sels.length} moving rules`);
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

test("the strip fills the middle of the header, takes no clicks, and cannot widen it", () => {
  const anchor = /\.chalk-season\s*\{([^}]*)\}/.exec(animated);
  assert.ok(anchor, "no .chalk-season rule");
  assert.match(anchor![1], /flex\s*:\s*1 1 0/);
  assert.match(anchor![1], /min-width\s*:\s*0/);
  assert.match(anchor![1], /align-self\s*:\s*stretch/);
  assert.match(anchor![1], /pointer-events\s*:\s*none/);
});

test("the canvas is out of flow, starts hidden, and fades into the header at both ends", () => {
  const rule = /\.chalk-season-canvas\s*\{([^}]*)\}/.exec(animated);
  assert.ok(rule, "no .chalk-season-canvas rule");
  assert.match(rule![1], /position\s*:\s*absolute/);
  assert.match(rule![1], /opacity\s*:\s*0/);
  assert.match(rule![1], /image-rendering\s*:\s*pixelated/);
  assert.match(rule![1], /mask-image\s*:\s*linear-gradient/);
  assert.ok(!/background\s*:/.test(rule![1]), "the canvas must blend, not fill");
});

test("the zucker row takes no height until the scene shows", () => {
  const row = /\.chalk-season--row\s*\{([^}]*)\}/.exec(animated);
  assert.ok(row, "no .chalk-season--row rule");
  assert.match(row![1], /height\s*:\s*0/);
  assert.match(row![1], /overflow\s*:\s*hidden/);
  assert.match(row![1], /flex\s*:\s*0 0 auto/);
  const live = /\.chalk-season--row\.chalk-season--live\s*\{([^}]*)\}/.exec(animated);
  assert.ok(live, "no live row rule");
  assert.match(live![1], /height\s*:\s*48px/);
});

test("129-6: the night frame is hidden by default and every season with a night has a rule", () => {
  const base = /\.chalk-voice-night\s*\{([^}]*)\}/.exec(animated);
  assert.ok(base, "no .chalk-voice-night rule");
  assert.match(base![1], /display\s*:\s*none/);
  assert.match(base![1], /pointer-events\s*:\s*none/);
  assert.match(base![1], /position\s*:\s*absolute/);
  for (const s of SEASONS) {
    const re = new RegExp(`html\\[data-season-night="${s.id}"\\] \\.chalk-voice-night\\s*\\{([^}]*)\\}`);
    const rule = re.exec(animated);
    if (s.night) {
      assert.ok(rule, `season ${s.id} has a night but no frame rule`);
      assert.match(rule![1], /display\s*:\s*block/);
      assert.match(rule![1], /box-shadow\s*:[^;]*inset/);
    } else {
      assert.equal(rule, null, `season ${s.id} has no night but a frame rule`);
    }
  }
});

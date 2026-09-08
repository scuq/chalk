// 115-4: the seam between flair's TypeScript and its stylesheet.
//
// Three things nothing else would notice if they broke: a flair animation
// that the reduced-motion block forgot (motion for a reader who asked for
// none), the banner drift reaching the editor's preview (a drifting focus
// target), and the wave's per-letter delays disagreeing with WAVE_MAX_LETTERS
// (a tail that never moves, or one that moves out of order).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { WAVE_MAX_LETTERS } from "./chat/wave";

const css = readFileSync(join(resolve(process.cwd(), "src"), "theme.css"), "utf8");
const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");

// The flair section runs from its banner comment to the end of the sheet.
const start = css.indexOf("Phase 115: flair");
assert.ok(start > 0, "the flair section banner comment is gone");
const section = css.slice(start).replace(/\/\*[\s\S]*?\*\//g, "");

// The reduced-motion block is the last rule of the section; take from its
// @media to the section's end.
const rmAt = section.lastIndexOf("@media (prefers-reduced-motion: reduce)");
assert.ok(rmAt > 0, "the flair section has no reduced-motion block");
const reduced = section.slice(rmAt);
const animated = section.slice(0, rmAt);

// Every `selector { ... animation: chalk-flair-... }` rule in the animated
// half, as its selector text with whitespace collapsed.
function animatedSelectors(text: string): string[] {
  const out: string[] = [];
  const rule = /([^{}]+)\{([^{}]*)\}/g;
  for (const m of text.matchAll(rule)) {
    const sel = m[1].trim().replace(/\s+/g, " ");
    if (sel.startsWith("@")) continue;
    if (/animation\s*:\s*chalk-flair-/.test(m[2])) out.push(sel);
  }
  return out;
}

test("every animated flair selector is switched off under reduced motion", () => {
  const sels = animatedSelectors(animated);
  assert.ok(sels.length >= 4, `expected the flair effects, found ${sels.length} animated rules`);
  const reducedFlat = reduced.replace(/\s+/g, " ");
  assert.ok(/animation\s*:\s*none/.test(reducedFlat), "the reduced-motion block sets no animation: none");
  for (const sel of sels) {
    assert.ok(reducedFlat.includes(sel), `reduced motion does not cover: ${sel}`);
  }
});

test("no flair animation is declared outside the flair section", () => {
  const before = stripped.slice(0, stripped.indexOf(".chalk-profile-flair-threshold"));
  assert.ok(!/chalk-flair-/.test(before), "a chalk-flair- rule lives above the flair section");
});

test("the banner drift never reaches the editor's preview", () => {
  for (const sel of animatedSelectors(animated)) {
    if (!sel.includes("chalk-channel-banner")) continue;
    assert.ok(
      sel.includes(":not(.chalk-channel-banner--preview)"),
      `banner rule may drift the editor preview: ${sel}`,
    );
  }
});

test("the wave carries one delay per letter position, in order", () => {
  const delays = [...animated.matchAll(/\.chalk-flair-wave-ch:nth-child\((\d+)\)\s*\{\s*animation-delay:\s*(\d+)ms/g)]
    .map((m) => [Number(m[1]), Number(m[2])] as const);
  assert.equal(delays.length, WAVE_MAX_LETTERS);
  for (let i = 0; i < delays.length; i++) {
    assert.equal(delays[i][0], i + 1, "positions are 1..N in order");
    if (i > 0) assert.ok(delays[i][1] > delays[i - 1][1], "delays increase left to right");
  }
  // The tail past the cap shares (at least) the last delay.
  const tail = /\.chalk-flair-wave-ch--tail\s*\{\s*animation-delay:\s*(\d+)ms/.exec(animated);
  assert.ok(tail, "no tail delay rule");
  assert.ok(Number(tail![1]) >= delays[delays.length - 1][1]);
});

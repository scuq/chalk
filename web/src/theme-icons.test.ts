// 133-13: the icon family, asserted against the source and the stylesheet.
//
// The sidebar and the channel header draw their icons from components/icons.tsx.
// The tests make sure that every icon has one viewBox and one stroke width,
// that no other file draws an inline SVG for these places, and that text and
// voice glyphs share one color while both governance badges take the accent.
// jsdom has no layout, so the tests cannot check that the icons line up. The
// manual checklist in docs/phases/PHASE-133-POLISH.md covers that.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(process.cwd(), "src");
const read = (p: string) => readFileSync(join(SRC, p), "utf8");
const css = read("theme.css").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[};])\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `theme.css has no parsable "${selector} { ... }" rule`);
  return m[1];
}

test("every icon in the shared module has one viewBox and one stroke width", () => {
  const icons = read("components/icons.tsx");
  assert.deepEqual(icons.match(/viewBox="[^"]*"/g), ['viewBox="0 0 24 24"']);
  assert.deepEqual(icons.match(/stroke-width="[^"]*"/g), ['stroke-width="2"']);
  assert.doesNotMatch(icons, /strokeWidth/);
});

test("the sidebar and the header badges draw no SVG of their own", () => {
  for (const f of ["components/Sidebar.tsx", "components/ModeBadge.tsx", "components/EncryptionIndicator.tsx"]) {
    assert.doesNotMatch(read(f), /<svg/, `${f} has an inline <svg>`);
  }
});

test("text and voice glyphs share one colour, and both governance badges take the accent", () => {
  assert.match(block(".chalk-chglyph"), /color:\s*var\(--chalk-fg-dim\)/);
  assert.doesNotMatch(css, /\.chalk-chglyph--voice\s*\{/);
  assert.doesNotMatch(block(".chalk-chglyph--header"), /color:/);
  assert.match(block(".chalk-mode-badge"), /color:\s*var\(--chalk-accent\)/);
  assert.doesNotMatch(css, /\.chalk-mode-democratic/);
});

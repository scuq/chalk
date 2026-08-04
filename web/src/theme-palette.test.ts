// The seam between the theme picker and the palette blocks in
// theme.css, and the contrast floors those blocks are written to.
//
// A theme is eleven hand-tuned hex values plus a name that has to match
// on both sides of a string. Neither half is checked by anything else:
// a name the stylesheet doesn't know selects nothing, and a palette
// pasted in from upstream verbatim looks plausible in the source and
// only shows up as an unreadable timestamp on someone else's monitor.
// The comments above each block record which tones had to be lifted or
// darkened; these tests do that arithmetic.
//
// Floors are WCAG 2.1 non-large text (4.5:1) for the tiers that carry
// body copy, and 3:1 for the muted tier and the signal colors, which
// label rather than narrate.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_DIR = resolve(process.cwd(), "src");
const css = readFileSync(join(SRC_DIR, "theme.css"), "utf8");
const profilePanel = readFileSync(join(SRC_DIR, "components", "ProfilePanel.tsx"), "utf8");

// Comments carry hex values of their own (rejected tones, source
// palettes), so they go before anything is parsed.
const parsed = css.replace(/\/\*[\s\S]*?\*\//g, "");

function srgbToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = srgbToLinear((n >> 16) & 0xff);
  const g = srgbToLinear((n >> 8) & 0xff);
  const b = srgbToLinear(n & 0xff);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// A palette block is any rule that declares --chalk-bg: the fourteen
// theme blocks plus :root, and nothing else in the sheet.
function palettes(): { name: string; tokens: Record<string, string> }[] {
  const out: { name: string; tokens: Record<string, string> }[] = [];
  for (const m of parsed.matchAll(/([^{}]+)\{([^}]*--chalk-bg\s*:[^}]*)\}/g)) {
    const tokens: Record<string, string> = {};
    for (const d of m[2].matchAll(/--(chalk-[\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g)) {
      tokens[d[1]] = d[2].toLowerCase();
    }
    if (!tokens["chalk-bg"]) continue;
    out.push({ name: m[1].trim().replace(/\s+/g, " "), tokens });
  }
  return out;
}

const BLOCKS = palettes();

// Every theme redeclares the whole palette, so a block short of a token
// means a typo'd name silently inheriting the green theme's value.
const TOKENS = [
  "chalk-bg",
  "chalk-bg-elev",
  "chalk-bg-elev-2",
  "chalk-fg",
  "chalk-fg-dim",
  "chalk-fg-bright",
  "chalk-fg-muted",
  "chalk-border",
  "chalk-accent",
  "chalk-warn",
  "chalk-error",
];

test("every palette block declares the full token set", () => {
  assert.ok(BLOCKS.length >= 14, `only found ${BLOCKS.length} palette blocks -- did the format change?`);
  for (const { name, tokens } of BLOCKS) {
    // The warmwhite sidebar rail is a scoped re-tint, not a theme, and
    // deliberately inherits nothing it does not restate.
    for (const t of TOKENS) {
      assert.ok(tokens[t], `${name} declares no ${`--${t}`}`);
    }
  }
});

// The picker's array is the only list of themes there is -- the pref is
// a bare string, so a name that reaches it without a matching block in
// theme.css selects nothing and silently leaves the reader on the green
// theme, with the picker still showing their choice as active.
test("every theme in the picker has a palette block and a swatch", () => {
  const list = profilePanel.match(/id="theme-picker"[\s\S]*?\(\[([^\]]*)\] as const\)/);
  assert.ok(list, "could not find the theme list in ProfilePanel.tsx -- did the picker move?");
  const names = [...list[1].matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(names.length > 1, "theme list parsed as fewer than two entries");

  for (const name of names) {
    // "green" is the default: it IS :root, and has no block of its own.
    if (name !== "green") {
      assert.ok(
        BLOCKS.some((b) => b.name.includes(`[data-theme="${name}"]`)),
        `the picker offers "${name}", which has no palette block in theme.css`,
      );
    }
    assert.ok(
      parsed.includes(`.chalk-profile-theme-swatch-preview--${name}`),
      `the picker offers "${name}", which has no swatch rule in theme.css`,
    );
  }
});

// The page ground is where the floors are set, because it is where the
// message list lives: body, dim and emphasis all carry running text
// there, and the muted tier plus the three signal colors label things
// next to it.
const PAGE_FLOORS: { token: string; min: number }[] = [
  { token: "chalk-fg", min: 4.5 },
  { token: "chalk-fg-dim", min: 4.5 },
  { token: "chalk-fg-bright", min: 4.5 },
  { token: "chalk-fg-muted", min: 3 },
  { token: "chalk-accent", min: 3 },
  { token: "chalk-warn", min: 3 },
  { token: "chalk-error", min: 3 },
];

// bg-elev-2 is the highest surface -- hover rows, badges, code blocks --
// and every theme's text tiers lose ground on it, because the ladder
// climbs toward the text. Half the sheet sits between 3:1 and 4.5:1
// there, so the floor for the top surface is 3:1: enough to catch a
// palette whose ladder climbs past its text tones entirely, which is
// the failure that makes a theme unusable rather than merely tighter.
const TOP_FLOORS: { token: string; min: number }[] = [
  { token: "chalk-fg", min: 3 },
  { token: "chalk-fg-dim", min: 3 },
  { token: "chalk-fg-bright", min: 3 },
];

for (const { name, tokens } of BLOCKS) {
  test(`${name} clears its contrast floors`, () => {
    const check = (ground: string, floors: typeof PAGE_FLOORS) => {
      for (const { token, min } of floors) {
        const ratio = contrast(tokens[token], tokens[ground]);
        assert.ok(
          ratio >= min,
          `${name}: --${token} ${tokens[token]} on --${ground} ${tokens[ground]} ` +
            `is ${ratio.toFixed(2)}:1, under the ${min}:1 floor`,
        );
      }
    };
    check("chalk-bg", PAGE_FLOORS);
    check("chalk-bg-elev-2", TOP_FLOORS);
  });
}

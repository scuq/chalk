// The seam between the font preference and the stylesheet.
//
// display-prefs.ts turns a stored choice into `var(--chalk-font-<value>)`
// by string interpolation, so nothing in TypeScript knows whether the
// stylesheet actually declares that variable -- and nothing in CSS knows
// whether a bundled woff2 is still on disk. Either break degrades to a
// silent fallback in the browser: the picker moves, the type doesn't
// change, no error anywhere. These tests are the only thing that notices.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { FONT_CHOICES } from "./display-prefs.ts";

// Tests are bundled into .test-build/ before they run, so import.meta.url
// points at the build dir. node test.mjs runs from web/, so anchor on cwd.
const SRC_DIR = resolve(process.cwd(), "src");
const THEME_CSS = join(SRC_DIR, "theme.css");
const css = readFileSync(THEME_CSS, "utf8");

// The four bundled families, by the name their @font-face rules claim.
const BUNDLED = ["Hack", "JetBrains Mono", "Fira Code", "Cascadia Code"];

// Comment-stripped, so a token that only "exists" inside a comment --
// or one stranded behind an unclosed one -- doesn't count. Prose that
// escapes its comment is swallowed by CSS error recovery along with the
// declaration that follows it, which is how --chalk-font-mono once
// disappeared while still reading fine in the source.
const parsed = css.replace(/\/\*[\s\S]*?\*\//g, "");

test("theme.css declares a family stack for every offered font", () => {
  for (const { value } of FONT_CHOICES) {
    // Anchored on the ; or { that ends the previous declaration: that is
    // exactly what error recovery eats when stray text precedes this one.
    const declared = new RegExp(`[;{]\\s*--chalk-font-${value}\\s*:`).test(parsed);
    assert.ok(
      declared,
      `theme.css has no parsable --chalk-font-${value} declaration for the "${value}" choice`,
    );
  }
});

test("every font url in theme.css points at a file that exists", () => {
  const urls = [...css.matchAll(/url\("([^"]+\.woff2?)"\)/g)].map((m) => m[1]);
  assert.ok(urls.length > 0, "no font urls found -- did the @font-face rules move?");
  for (const url of urls) {
    const path = resolve(dirname(THEME_CSS), url);
    assert.ok(existsSync(path), `theme.css references ${url}, which is missing`);
  }
});

// Bold is not decorative here: the UI sets font-weight 600/700 on
// headings, sender names and buttons. A family missing its bold face
// gets a synthesized one that sits visibly wrong next to the others.
test("every bundled family ships an upright regular and bold", () => {
  for (const family of BUNDLED) {
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)]
      .map((m) => m[1])
      .filter((body) => body.includes(`font-family: "${family}"`));
    assert.ok(faces.length > 0, `no @font-face rules for ${family}`);
    for (const weight of ["400", "700"]) {
      assert.ok(
        faces.some(
          (f) => f.includes(`font-weight: ${weight}`) && f.includes("font-style: normal"),
        ),
        `${family} has no upright ${weight} face`,
      );
    }
  }
});

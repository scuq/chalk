// Holds theme.css to one rule: every custom property it reads is
// declared somewhere.
//
// An undeclared var() with no fallback is not an error. The browser drops
// the whole declaration without a message, so the rule draws no color,
// size, or font and nothing in the build shows it. Seven tokens had
// slipped through this way: --chalk-bg-hover, --chalk-size-body,
// --chalk-danger, --chalk-mono, --chalk-bg-alt, --chalk-row-hover, and
// --chalk-surface.
//
// A property counts as declared when the sheet sets it, or when a
// non-test .ts or .tsx file under src sets it, for example inline on an
// element. Comments in the sheet are removed before the check.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_DIR = resolve(process.cwd(), "src");
const css = readFileSync(join(SRC_DIR, "theme.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function scriptSources(): string {
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" }).filter(
    (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f),
  );
  return files.map((f) => readFileSync(join(SRC_DIR, f), "utf8")).join("\n");
}

const scripts = scriptSources();

test("every custom property the sheet reads is declared in the sheet or set by the client", () => {
  const read = new Set([...css.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]));
  const declared = new Set([...css.matchAll(/(?:^|[\s;{])(--[\w-]+)\s*:/g)].map((m) => m[1]));
  const missing: string[] = [];
  for (const name of read) {
    if (declared.has(name)) continue;
    if (scripts.includes(`"${name}"`) || scripts.includes(`'${name}'`) || scripts.includes(`\`${name}`) || scripts.includes(`${name}:`)) continue;
    missing.push(name);
  }
  assert.deepEqual(missing.sort(), [], `theme.css reads custom properties nothing declares: ${missing.join(", ")}`);
});

// A fallback on a token that the sheet always declares never applies, so it
// is dead code. The dead values were the old green palette, and they misled
// anyone who read the sheet. A fallback stays legal on a token that a
// script writes inline, because it applies until the script runs.
test("palette and derived tokens carry no var() fallback", () => {
  const always = new Set([...css.matchAll(/(?:^|[\s;{])(--chalk-[\w-]+)\s*:/g)].map((m) => m[1]));
  const offenders = [...css.matchAll(/var\(\s*(--chalk-[\w-]+)\s*,[^)]*\)/g)]
    .filter((m) => always.has(m[1]) && !scripts.includes(`"${m[1]}"`) && !scripts.includes(`'${m[1]}'`))
    .map((m) => m[0]);
  assert.deepEqual(offenders, [], `dead fallbacks on tokens the sheet always declares: ${offenders.join(", ")}`);
});

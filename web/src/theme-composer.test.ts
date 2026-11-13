// 133-5: the composer rules in theme.css and the always-mounted tool block in
// Composer.tsx. The tests read the source text. They do not render the
// component.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_DIR = resolve(process.cwd(), "src");
const css = readFileSync(join(SRC_DIR, "theme.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const composer = readFileSync(join(SRC_DIR, "components", "Composer.tsx"), "utf8");

function block(selector: string, indent = ""): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)${indent}${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `no "${indent}${selector} { ... }" rule`);
  return m[1];
}

test("desktop composer tools are one row on a shared surface", () => {
  const tools = block(".chalk-composer-tools");
  assert.match(tools, /display:\s*flex;/);
  assert.match(tools, /background:\s*var\(--chalk-bg-elev\)/);
  assert.match(block(".chalk-composer-tool"), /border:\s*none;/);
});

test("the phone keeps its 2x2 block of bordered squares", () => {
  const tools = block(".chalk-composer-tools", "  ");
  assert.match(tools, /display:\s*grid;/);
  assert.match(tools, /grid-template-columns:\s*repeat\(2, auto\);/);
  assert.match(block(".chalk-composer-tool", "  "), /border:\s*1px solid var\(--chalk-border\)/);
  assert.match(block(".chalk-composer-rail--icons .chalk-composer-tool", "  "), /width:\s*44px;/);
});

test("send is filled with the accent and readable through the on-accent token", () => {
  const send = block(".chalk-composer-send");
  assert.match(send, /background:\s*var\(--chalk-accent\)/);
  assert.match(send, /color:\s*var\(--chalk-on-accent\)/);
  assert.match(block(".chalk-composer-send:disabled"), /background:\s*transparent/);
});

test("an edit hides the tools without unmounting them, so the field keeps its place", () => {
  assert.match(composer, /chalk-composer-tools--hidden/);
  assert.doesNotMatch(composer, /\{showTools && \(\s*<div class="chalk-composer-tools"/);
  assert.match(block(".chalk-composer-tools--hidden"), /visibility:\s*hidden/);
});

// 133-14: the composer as one control, from the external design review. These
// tests read the source text, as the tests above do.
test("desktop icon tools are 30px by 32px and turn to the accent on hover", () => {
  const tool = block(".chalk-composer-rail--icons .chalk-composer-tool");
  assert.match(tool, /width:\s*30px;/);
  assert.match(tool, /height:\s*32px;/);
  assert.match(block(".chalk-composer-tool:hover:not(:disabled),\n.chalk-composer-tool:active:not(:disabled)"), /color:\s*var\(--chalk-accent\)/);
  assert.match(block(".chalk-composer-tool:focus-visible"), /outline-offset:\s*-2px/);
});

test("the field is 60px by default, scrolls inside, and keeps the dragged height", () => {
  const input = block(".chalk-composer-input");
  assert.match(input, /min-height:\s*60px;/);
  assert.match(input, /overflow-y:\s*auto;/);
  assert.match(input, /height:\s*var\(--chalk-composer-h, auto\)/);
  assert.match(block(".chalk-composer-input:focus"), /border-color:\s*var\(--chalk-accent\)/);
});

test("send shows the arrow, and an edit keeps the word", () => {
  assert.match(composer, /<SendIcon \/>/);
  assert.match(composer, /aria-label=\{editing \? undefined : "send"\}/);
  assert.match(composer, /sending \? "saving…" : "save"/);
});

test("the legacy attach and GIF button rules are gone", () => {
  assert.doesNotMatch(css, /\.chalk-composer-(attach|giphy)\b/);
  assert.doesNotMatch(composer, /chalk-composer-(attach|giphy)\b/);
});

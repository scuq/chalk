// 133-6: the empty states. The mark is the logo in the theme tone, and only
// a titled empty feed takes the tall layout.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_DIR = resolve(process.cwd(), "src");
const read = (...p: string[]) => readFileSync(join(SRC_DIR, ...p), "utf8");
const css = read("theme.css").replace(/\/\*[\s\S]*?\*\//g, "");
const list = read("components", "MessageList.tsx");
const app = read("components", "App.tsx");
const thread = read("components", "ThreadPanel.tsx");
const logo = read("components", "Logo.tsx");

function block(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `no "${selector} { ... }" rule`);
  return m[1];
}

test("the empty-state mark is the logo drawn in the theme, not the brand gradient", () => {
  assert.match(logo, /tone === "theme"/);
  assert.match(list, /<Logo class="chalk-empty-mark" tone="theme" \/>/);
  assert.match(app, /<Logo class="chalk-empty-mark" tone="theme" \/>/);
  assert.match(block(".chalk-empty-mark"), /color:\s*var\(--chalk-accent\)/);
});

test("only a titled empty feed takes the tall centred layout", () => {
  assert.match(list, /emptyTitle \? \(/);
  assert.doesNotMatch(thread, /emptyTitle=/, "the thread panel keeps its one-line hint");
  assert.match(block(".chalk-messages--empty:has(.chalk-empty)"), /min-height:\s*50vh/);
});

// 137-2: the message grouping rules in theme.css, MessageList.tsx, and
// MessageMenu.tsx. The tests read the source text. They do not render the
// component.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC_DIR = resolve(process.cwd(), "src");
const css = readFileSync(join(SRC_DIR, "theme.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const list = readFileSync(join(SRC_DIR, "components", "MessageList.tsx"), "utf8");
const menu = readFileSync(join(SRC_DIR, "components", "MessageMenu.tsx"), "utf8");

function block(selector: string, indent = ""): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)${indent}${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `no "${indent}${selector} { ... }" rule`);
  return m[1];
}

test("a day mark or the unread divider always starts a new run", () => {
  assert.match(list, /!dayMarks\.has\(mi\)\s*&&\s*mi !== dividerIndex\s*&&\s*continuesRun\(messages\[mi - 1\], m\)/);
  assert.match(list, /cont \? "chalk-message--cont" : ""/);
});

test("only the phone hides the time and sender of a continued row", () => {
  assert.doesNotMatch(css, /\n\.chalk-message--cont/);
  assert.match(block(".chalk-message--cont .chalk-message-time,\n  .chalk-message--cont .chalk-message-sender", "  "), /display:\s*none;/);
});

test("the menu carries the time, and only the phone shows it", () => {
  assert.match(list, /when=\{m\.ts\.toLocaleString\(\)\}/);
  assert.match(menu, /data-testid="message-menu-when"/);
  assert.match(block(".chalk-msgmenu-when"), /display:\s*none;/);
  assert.match(block(".chalk-msgmenu-when", "  "), /display:\s*block;/);
});

test("phone message text is 15px with a 1.5 line height and breaks long tokens", () => {
  const body = block(".chalk-message-body", "  ");
  assert.match(body, /font-size:\s*calc\(15px \* var\(--chalk-font-scale\)\);/);
  assert.match(body, /line-height:\s*1\.5;/);
  assert.match(body, /overflow-wrap:\s*anywhere;/);
});

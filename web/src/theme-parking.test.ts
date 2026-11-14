// 53-6: the parking mark stays still. An endless animation kept the renderer,
// the GPU process, and the window manager busy while chalk sat parked.
// 137-6: on the phone the mark is 96px wide, and its opacity does not change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const css = readFileSync(join(resolve(process.cwd(), "src"), "theme.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function block(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|\\n)${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `no "${selector} { ... }" rule`);
  return m[1];
}

test("the parking mark does not animate", () => {
  assert.doesNotMatch(block(".chalk-parking-mark"), /animation/);
  assert.doesNotMatch(css, /chalk-parking-drift/);
});

test("on the phone the parking mark is 96px, and its dimness does not change", () => {
  const at = css.indexOf("@media (max-width: 767px) {\n  .chalk-parking-mark {");
  assert.ok(at > css.indexOf(".chalk-parking-mark {"), "the phone rule must come after the base rule, or the base rule wins");
  assert.match(css.slice(at, css.indexOf("}", at) + 1), /width:\s*96px;/);
  assert.match(block(".chalk-parking-mark"), /opacity:\s*0\.28;/);
});

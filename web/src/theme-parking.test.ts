// 53-6: the parking mark stays still. An endless animation kept the renderer,
// the GPU process, and the window manager busy while chalk sat parked.
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

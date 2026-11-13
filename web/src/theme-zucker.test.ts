// 126-1, 135-1: two theme.css assertions, checked against the stylesheet
// because jsdom has no layout to measure.
//
// The first is the "@ voice" shelf's flex-shrink: it must be 0, or the
// shelf gives up part of a real column overflow to the conversation list
// above it, and a one-room shelf clips mid-row (126-1; the wrong reasoning
// this replaces is in the 95-3 comment in theme.css). The measurements
// behind it are in docs/phases/PHASE-126-ZUCKERCALL.md.
//
// The second test (135-1) checks that the stylesheet has no drawer rules.
// 135-5 removed the call bar margin test with the bar it checked. The
// phone call bar has its own assertions in theme-phone-call.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const THEME_CSS = join(resolve(process.cwd(), "src"), "theme.css");
const css = readFileSync(THEME_CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`(?:^|[};])\\s*${esc}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(m, `no parsable "${selector} { ... }" rule`);
  return m[1];
}

test("a zucker shelf keeps its rows whole when the list below overflows", () => {
  const decls = block(".chalk-zucker-rows--shelf");
  const flex = /flex:\s*([^;]+);/.exec(decls);
  assert.ok(flex, "the shelf declares no flex shorthand");
  const [grow, shrink] = flex[1].trim().split(/\s+/);
  assert.equal(grow, "0", "the shelf must not grow into the list");
  assert.equal(shrink, "0", "the shelf must not give up its rows to the list");
  assert.match(decls, /max-height:\s*\d+vh/, "the shelf keeps its viewport cap and scrolls past it");
});

test("the stylesheet has no drawer rules", () => {
  for (const gone of [".chalk-nav-toggle", ".chalk-nav-backdrop", ".chalk-drawer-", ".chalk-app--nav-open"]) {
    assert.equal(css.includes(gone), false, `${gone} is still in theme.css`);
  }
});

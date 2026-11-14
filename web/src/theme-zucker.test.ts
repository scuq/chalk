// 126-1, 135-1, 137-3, 137-4: assertions about theme.css, checked against the stylesheet
// because jsdom has no layout to measure.
//
// The first is the "@ voice" shelf's flex-shrink: it must be 0, or the
// shelf gives up part of a real column overflow to the conversation list
// above it, and a one-room shelf clips mid-row (126-1; the wrong reasoning
// this replaces is in the 95-3 comment in theme.css). The measurements
// behind it are in docs/phases/PHASE-126-ZUCKERCALL.md.
//
// The second test (135-1) checks that the stylesheet has no drawer rules.
//
// Five tests (137-3) check the phone conversation rows:
//   - The row is 64px high, has 16px of side padding, and shades while pressed.
//   - The head, the pinned rows, and the filter share the 16px left edge.
//   - Only an unread name is bold.
//   - The unread dot is at the end of the preview line.
//   - The last row of a shelf has no bottom border.
//
// Two tests (137-4) check the phone list section rows:
//   - The three rows that expand carry a chevron, and parking and threads do not.
//   - The chevron turns with aria-expanded, the sublists fade in, and a pressed row shades.
//
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

test("a conversation row is 64px high, 16px in from the edge, and shades while pressed", () => {
  const row = block(".chalk-zucker-row");
  assert.match(row, /min-height:\s*64px;/);
  assert.match(row, /padding:\s*var\(--chalk-s2\) var\(--chalk-s4\);/);
  assert.match(row, /touch-action:\s*manipulation;/);
  assert.match(block(".chalk-zucker-row:active"), /background:\s*var\(--chalk-bg-hover\);/);
});

test("the head, the pinned rows, and the filter share the rows' 16px left edge", () => {
  assert.match(block(".chalk-zucker-head"), /padding:\s*var\(--chalk-s2\) var\(--chalk-s4\);/);
  assert.match(block(".chalk-zucker-pinned"), /padding:\s*0 var\(--chalk-s4\);/);
  assert.match(block(".chalk-zucker-filter"), /padding:\s*var\(--chalk-s2\) var\(--chalk-s4\);/);
});

// Every bundled font has only a 400 face and a 700 face, so a weight of 600
// renders bold. A read name keeps the regular weight, so that bold means unread.
test("only an unread name is bold, and the colour does not change", () => {
  const name = block(".chalk-zucker-row-name");
  assert.doesNotMatch(name, /font-weight/);
  assert.match(name, /color:\s*var\(--chalk-fg-bright\);/);
  const unread = block(".chalk-zucker-row--unread .chalk-zucker-row-name");
  assert.match(unread, /font-weight:\s*700;/);
  assert.doesNotMatch(unread, /color:/);
});

test("the unread dot sits at the end of the preview line, so the times line up on every row", () => {
  const list = readFileSync(join(resolve(process.cwd(), "src"), "components", "ZuckerList.tsx"), "utf8");
  assert.match(
    list,
    /<span class="chalk-zucker-row-bottom">[\s\S]*?\{r\.unread && <UnreadDot mention=\{r\.mention\} \/>\}\s*<\/span>\s*<\/span>\s*<\/button>/,
  );
  assert.match(block(".chalk-zucker-row-bottom"), /display:\s*flex;/);
  assert.match(block(".chalk-zucker-row-preview"), /flex:\s*1 1 auto;/);
});

test("the three rows that expand carry a chevron, and the rows that open a screen do not", () => {
  const list = readFileSync(join(resolve(process.cwd(), "src"), "components", "ZuckerList.tsx"), "utf8");
  const chevrons = list.match(/<span class="chalk-zucker-chevron" aria-hidden="true"><ChevronIcon \/><\/span>/g) ?? [];
  assert.equal(chevrons.length, 3);
  for (const id of ["zucker-friends", "zucker-voice", "zucker-hidden-toggle"]) {
    const at = list.indexOf(`data-testid="${id}"`);
    assert.ok(at > 0, id);
    assert.match(list.slice(at, list.indexOf("</button>", at)), /chalk-zucker-chevron/, `${id} has no chevron`);
  }
  for (const id of ["zucker-parking", "zucker-threads"]) {
    const at = list.indexOf(`data-testid="${id}"`);
    assert.doesNotMatch(list.slice(at, list.indexOf("</button>", at)), /chalk-zucker-chevron/, `${id} has a chevron`);
  }
  assert.doesNotMatch(list, /"▾" : "▸"/);
});

test("the chevron turns with aria-expanded on the duration token, and a sublist fades in", () => {
  assert.match(block('.chalk-zucker-pinned[aria-expanded="true"] .chalk-zucker-chevron'), /transform:\s*rotate\(90deg\);/);
  assert.match(block(".chalk-zucker-chevron"), /transition:\s*transform var\(--chalk-dur\);/);
  assert.match(block(".chalk-zucker-friends,\n  .chalk-zucker-rows--shelf"), /animation:\s*chalk-zucker-shelf-in var\(--chalk-dur\)/);
  assert.match(block(".chalk-zucker-pinned:active"), /background:\s*var\(--chalk-bg-hover\);/);
});

test("the last row of a shelf leaves the bottom line to the shelf", () => {
  assert.match(block(".chalk-zucker-rows--shelf li:last-child .chalk-zucker-row"), /border-bottom:\s*none;/);
});

test("the stylesheet has no drawer rules", () => {
  for (const gone of [".chalk-nav-toggle", ".chalk-nav-backdrop", ".chalk-drawer-", ".chalk-app--nav-open"]) {
    assert.equal(css.includes(gone), false, `${gone} is still in theme.css`);
  }
});

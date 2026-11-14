// 126-1, 135-1, 137-3, 137-4, 137-8, 137-9, 137-10, 137-11: assertions about theme.css, checked against the stylesheet
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
//   - The three rows that expand carry a chevron. Parking and threads were rows
//     without one in 137-4, and 137-10 made them head buttons.
//   - The chevron turns with aria-expanded, the sublists fade in, and a pressed row shades.
//
// Four tests (137-8, 137-11) check the friends bar and the friend chips:
//   - The bar has no label while it shows chips, and the count and the chevron
//     sit at its right end (137-11).
//   - The chips wrap to two lines beside a 44px toggle, and the name cut comes
//     from the measured fit (137-11).
//   - A chip is a 44px target around a pill, no chip paints before it is measured,
//     and the resize watcher attaches when the line appears.
//
// Three tests (137-9) check the filter bar:
//   - The bar sits under the head with the name field and one chip for each kind.
//   - Closing the bar clears the text and the kind, and an open bar hides the
//     rows that are not conversations (only the friends row since 137-10).
//   - A filter opens the voice and hidden shelves on a hit, and "no matches"
//     counts all three lists.
//
// Two tests (137-10) check the buttons of the list head:
//   - The head holds five icon buttons in order, with no text glyph, and the
//     parking lot button carries the name of the parking lot.
//   - A button is a 44px square with no box, and the title gives way on a
//     narrow phone.
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
  assert.match(block(".chalk-zucker-filter"), /padding:\s*var\(--chalk-s2\) var\(--chalk-s4\) 0 var\(--chalk-s4\);/);
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

test("the friends bar has no label while it shows chips, and the count and chevron sit at its right end", () => {
  const list = readFileSync(join(resolve(process.cwd(), "src"), "components", "ZuckerList.tsx"), "utf8");
  const bar = list.slice(list.indexOf('class="chalk-zucker-friendsbar"'), list.indexOf('class="chalk-zucker-friends"'));
  // The label shows only when there are no chips: an open list, or no friends.
  assert.match(bar, /\{friendsOpen \|\| friends\.length === 0 \? \(\s*<span class="chalk-zucker-friendsbar-label">@ friends<\/span>\s*\) : \(\s*<FriendChips/);
  assert.match(bar, /onMore=\{\(\) => setFriendsOpen\(true\)\}/);
  assert.ok(bar.indexOf("<FriendChips") < bar.indexOf('data-testid="zucker-friends"'), "the toggle must come after the chips");
  assert.match(bar, /\{onlineCount\}\/\{friends\.length\}\s*<\/span>/);
  assert.doesNotMatch(bar, /online\s*<\/span>/);
  // The count alone says little to a screen reader, so the button names it.
  assert.match(bar, /aria-label=\{`friends, \$\{onlineCount\} of \$\{friends\.length\} online`\}/);
});

test("the chips wrap to two lines beside a 44px toggle, and the name cut comes from the measured fit", () => {
  const chips = block(".chalk-zucker-chips");
  assert.match(chips, /flex-wrap:\s*wrap;/);
  assert.match(chips, /max-height:\s*88px;/);
  assert.match(chips, /overflow:\s*hidden;/);
  assert.match(chips, /flex:\s*1 1 0;/);
  const toggle = block(".chalk-zucker-friends-toggle");
  assert.match(toggle, /flex:\s*0 0 auto;/);
  assert.match(toggle, /height:\s*44px;/);
  assert.match(block('.chalk-zucker-friends-toggle[aria-expanded="true"] .chalk-zucker-chevron'), /transform:\s*rotate\(90deg\);/);
  assert.match(block(".chalk-zucker-chip-name"), /max-width:\s*var\(--chalk-chip-name-max, none\);/);
  const chipsSrc = readFileSync(join(resolve(process.cwd(), "src"), "components", "FriendChips.tsx"), "utf8");
  assert.match(chipsSrc, /--chalk-chip-name-max:\$\{Math\.floor\(fit\.nameCap\)\}px/);
});

test("a chip is a 44px target around a small pill, and no chip paints before it is measured", () => {
  assert.match(block(".chalk-zucker-chip"), /height:\s*44px;/);
  assert.match(block(".chalk-zucker-chip-pill"), /border:\s*1px solid var\(--chalk-border\);/);
  assert.match(block(".chalk-zucker-chips--measuring"), /visibility:\s*hidden;/);
  // An ellipsis costs one letter of a four-letter name. The pill edge shows the cut.
  assert.match(block(".chalk-zucker-chip-name"), /text-overflow:\s*clip;/);
  // The line does not exist while there are no friends. The resize watcher
  // must attach when the line appears, not only at the first render.
  const chipsSrc = readFileSync(join(resolve(process.cwd(), "src"), "components", "FriendChips.tsx"), "utf8");
  assert.match(chipsSrc, /ro\.observe\(el\);\s*return \(\) => ro\.disconnect\(\);\s*\}, \[empty\]\);/);
});

test("the filter bar sits under the head with the name field and one chip for each kind", () => {
  const list = readFileSync(join(resolve(process.cwd(), "src"), "components", "ZuckerList.tsx"), "utf8");
  const head = list.indexOf('class="chalk-zucker-head"');
  const bar = list.indexOf('class="chalk-zucker-filter"');
  const friends = list.indexOf('data-testid="zucker-friends"');
  assert.ok(head > 0 && head < bar && bar < friends, "the bar must come after the head and before the pinned rows");
  assert.match(list, /ZUCKER_KINDS\.map\(\(k\) => \(\s*<button[\s\S]*?aria-pressed=\{kind === k\.kind\}/);
  const kinds = block(".chalk-zucker-kinds");
  assert.match(kinds, /flex-wrap:\s*nowrap;/);
  assert.match(kinds, /overflow-x:\s*auto;/);
  assert.match(block(".chalk-zucker-kind--on .chalk-zucker-chip-pill"), /border-color:\s*var\(--chalk-fg-bright\);/);
});

test("closing the bar clears the text and the kind, and an open bar hides the rows that are not conversations", () => {
  const list = readFileSync(join(resolve(process.cwd(), "src"), "components", "ZuckerList.tsx"), "utf8");
  assert.match(list, /if \(filterOpen\) \{\s*setFilter\(""\);\s*setKind\("all"\);\s*\}/);
  assert.equal(list.match(/\{!filterOpen && \(/g)?.length, 1);
});

test("a filter opens the voice and hidden shelves on a hit, and no matches counts all three lists", () => {
  const list = readFileSync(join(resolve(process.cwd(), "src"), "components", "ZuckerList.tsx"), "utf8");
  assert.match(list, /const voiceShowing = filtering \? shownVoice\.length > 0 : voiceOpen;/);
  assert.match(list, /const hiddenShowing = filtering \? shownHidden\.length > 0 : hiddenOpen;/);
  assert.match(list, /\{filtering && visibleRows\.length === 0 && shownVoice\.length === 0 && shownHidden\.length === 0 && \(/);
});

test("the head holds five icon buttons: parking, threads, filter, add friend, new channel", () => {
  const list = readFileSync(join(resolve(process.cwd(), "src"), "components", "ZuckerList.tsx"), "utf8");
  const head = list.slice(list.indexOf('class="chalk-zucker-head"'), list.indexOf('class="chalk-zucker-filter"'));
  const order = ["zucker-parking", "zucker-threads", "zucker-filter-toggle", "zucker-add-friend", "zucker-new-channel"].map((id) =>
    head.indexOf(`data-testid="${id}"`),
  );
  assert.ok(order.every((at) => at > 0), "a head button is missing");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  for (const icon of ["<ParkingIcon size={18} />", "<ThreadsIcon />", "<FilterIcon />", "<AddFriendIcon />", "<NewChannelIcon />"]) {
    assert.ok(head.includes(icon), `${icon} is not in the head`);
  }
  // No text glyph stands in for an icon, and parking and threads are no longer rows.
  assert.doesNotMatch(head, /⌕|@\+/);
  assert.doesNotMatch(list, /↳ threads/);
  // The parking lot can have any name, so the button carries it for a screen reader.
  assert.match(head, /aria-label=\{parkingName\}/);
});

test("a head button is a 44px square with no box, and the title gives way on a narrow phone", () => {
  const add = block(".chalk-zucker-add");
  assert.match(add, /width:\s*44px;/);
  assert.match(add, /height:\s*44px;/);
  assert.match(add, /border:\s*none;/);
  assert.match(block(".chalk-zucker-add:active"), /background:\s*var\(--chalk-bg-hover\);/);
  assert.match(block(".chalk-zucker-add-dot"), /background:\s*var\(--chalk-unread\);/);
  assert.match(block(".chalk-zucker-title"), /text-overflow:\s*ellipsis;/);
  assert.match(css, /@media \(max-width: 359px\) \{\s*\.chalk-zucker-title \{\s*display:\s*none;/);
});

test("the last row of a shelf leaves the bottom line to the shelf", () => {
  assert.match(block(".chalk-zucker-rows--shelf li:last-child .chalk-zucker-row"), /border-bottom:\s*none;/);
});

test("the stylesheet has no drawer rules", () => {
  for (const gone of [".chalk-nav-toggle", ".chalk-nav-backdrop", ".chalk-drawer-", ".chalk-app--nav-open"]) {
    assert.equal(css.includes(gone), false, `${gone} is still in theme.css`);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { splitBodyNano, stripNanoMarks } from "./nanomd.ts";
import { splitBodyParts } from "./links.ts";
import { selectChatPrefs } from "../state/types.ts";

const known = new Set(["alice", "bob"]);

// The text of each part, in order.
const t = (body: string) => splitBodyNano(body, known).map((p) => p.text);

// One letter per mark on each part: c(ode), b(old), i(talic), "-" for plain.
const m = (body: string) =>
  splitBodyNano(body, known).map(
    (p) => (p.code ? "c" : "") + (p.bold ? "b" : "") + (p.italic ? "i" : "") || "-",
  );

const parts = (body: string) => splitBodyNano(body, known);

// Everything except the markers themselves.
const words = (s: string) => s.replace(/[*`]/g, "");

test("a body with no marker is the plain split, unchanged", () => {
  const body = "hello @alice, see https://x.example/page ok";
  assert.deepEqual(splitBodyNano(body, known), splitBodyParts(body, known));
});

test("one plain segment stays one plain segment", () => {
  // MessageBody's fast path depends on this: one unmarked part means the
  // renderer can return the raw body and skip the map entirely.
  assert.deepEqual(splitBodyNano("just talking", known), [{ text: "just talking" }]);
});

test("backticks make an inline code piece", () => {
  assert.deepEqual(t("a `x` b"), ["a ", "x", " b"]);
  assert.deepEqual(m("a `x` b"), ["-", "c", "-"]);
});

test("code is literal: no links, no mentions inside it", () => {
  const p = parts("`@alice https://x.example`");
  assert.equal(p.length, 1);
  assert.equal(p[0].text, "@alice https://x.example");
  assert.equal(p[0].code, true);
  assert.equal(p[0].handle, undefined);
  assert.equal(p[0].href, undefined);
});

test("an unterminated or empty backtick is just text", () => {
  assert.deepEqual(t("a `x b"), ["a `x b"]);
  assert.deepEqual(t("a `` b"), ["a `` b"]);
});

test("code does not cross a newline", () => {
  assert.deepEqual(t("a `x\ny` b"), ["a `x\ny` b"]);
});

test("one star is italic, two bold, three both", () => {
  assert.deepEqual(t("*a*"), ["a"]);
  assert.deepEqual(m("*a*"), ["i"]);
  assert.deepEqual(m("**a**"), ["b"]);
  assert.deepEqual(m("***a***"), ["bi"]);
});

test("emphasis nests, and code nests inside it", () => {
  assert.deepEqual(t("**a *b* c**"), ["a ", "b", " c"]);
  assert.deepEqual(m("**a *b* c**"), ["b", "bi", "b"]);
  assert.deepEqual(t("**a `b` c**"), ["a ", "b", " c"]);
  assert.deepEqual(m("**a `b` c**"), ["b", "cb", "b"]);
});

test("prose that happens to contain stars is left alone", () => {
  for (const body of [
    "2 * 3 * 4",
    "2*3*4",
    "a*b",
    "*",
    "**",
    "***",
    "****a****",
    "rm *.txt *.log",
    "snake*case*thing",
    "**bold**ish",
    "5 * 3 = 15",
  ]) {
    assert.deepEqual(t(body), [body], body);
  }
});

test("emphasis may be wrapped in brackets or quotes", () => {
  assert.deepEqual(t('("*a*")'), ['("', "a", '")']);
  assert.deepEqual(m('("*a*")'), ["-", "i", "-"]);
  assert.deepEqual(t("*a*, then"), ["a", ", then"]);
});

test("emphasis does not cross a newline", () => {
  assert.deepEqual(t("*a\nb*"), ["*a\nb*"]);
  assert.deepEqual(t("*a*\n*b*"), ["a", "\n", "b"]);
  assert.deepEqual(m("*a*\n*b*"), ["i", "-", "i"]);
});

test("a link inside emphasis stays a link, and gets the mark", () => {
  const p = parts("**see https://x.example ok**");
  assert.deepEqual(
    p.map((x) => x.text),
    ["see ", "https://x.example", " ok"],
  );
  assert.equal(p[1].href, "https://x.example");
  assert.equal(p[1].bold, true);
});

test("a mention inside emphasis stays a mention, and gets the mark", () => {
  const p = parts("**hi @alice**");
  assert.equal(p[1].handle, "alice");
  assert.equal(p[1].bold, true);
});

test("links win over emphasis, exactly as they win over mentions", () => {
  // The url pattern eats the trailing star, so no closer is left to pair
  // with. What the reader clicks stays what they see.
  const p = parts("*https://x.example*");
  assert.deepEqual(
    p.map((x) => x.text),
    ["*", "https://x.example*"],
  );
  assert.equal(p[1].href, "https://x.example*");
  assert.equal(p[1].italic, undefined);
});

test("a star inside a url never splits it", () => {
  const p = parts("https://x.example/a*b*c");
  assert.equal(p.length, 1);
  assert.equal(p[0].href, "https://x.example/a*b*c");
  assert.equal(p[0].italic, undefined);
});

test("there are no escapes: a backslash is a literal backslash", () => {
  // Deliberate. A sender's escape would show as a stray backslash to every
  // reader who has nano markdown off, which is the default. It reads as an
  // ordinary word character, so it blocks the emphasis rather than escaping
  // it.
  assert.deepEqual(t("\\*a\\*"), ["\\*a\\*"]);
});

test("no consumed delimiter survives into a part's text", () => {
  for (const body of ["*a*", "**a**", "***a***", "`a`", "**a *b* `c`**"]) {
    assert.equal(t(body).join(""), words(t(body).join("")), body);
  }
});

test("text is never lost: unmarked bodies rejoin exactly", () => {
  for (const body of ["2 * 3 * 4", "*a\nb*", "a `x b", "hi @alice ***", "", "\n\n"]) {
    assert.equal(t(body).join(""), body, JSON.stringify(body));
  }
});

test("a tangle of unbalanced markers is well defined, not a crash", () => {
  // Whatever the scanner decides, only markers may ever go missing: no word
  // of what someone wrote can be swallowed by a stray star.
  for (const body of ["*a **b* c**", "**a *b***", "`a *b` c*", "***a*", "*a***"]) {
    assert.equal(words(t(body).join("")), words(body), body);
  }
});

test("a body that is mostly markers stays cheap enough to render", () => {
  const started = process.hrtime.bigint();
  splitBodyNano("*a ".repeat(2000), known);
  splitBodyNano("*".repeat(5000), known);
  splitBodyNano("`a ".repeat(2000), known);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 500, `took ${ms.toFixed(0)}ms`);
});

test("the pref is off until someone asks for it", () => {
  assert.equal(selectChatPrefs(undefined).nanoMarkdown, false);
  assert.equal(selectChatPrefs({}).nanoMarkdown, false);
  assert.equal(selectChatPrefs({ chat: {} }).nanoMarkdown, false);
  assert.equal(selectChatPrefs({ chat: { nanoMarkdown: true } }).nanoMarkdown, true);
});

test("stripNanoMarks drops the markers and keeps the words", () => {
  assert.equal(stripNanoMarks("**a *b* `c`**", known), "a b c");
  assert.equal(stripNanoMarks("2 * 3 * 4", known), "2 * 3 * 4");
});

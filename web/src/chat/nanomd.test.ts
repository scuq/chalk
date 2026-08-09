import { test } from "node:test";
import assert from "node:assert/strict";
import { splitBodyBlocks, splitBodyNano, stripNanoMarks } from "./nanomd.ts";
import { QUOTE_MAX_DEPTH, quoteDepth, stripQuote } from "./quote.ts";
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

test("a span covers as many words as it likes, up to the line end", () => {
  // The whole-word rule is about where a run starts and ends, not how much
  // it wraps: only the inner edges have to hug a non-space.
  assert.deepEqual(m("**two whole words**"), ["b"]);
  assert.deepEqual(t("**two whole words**"), ["two whole words"]);
  assert.deepEqual(m("*a whole sentence, with punctuation*"), ["i"]);
  assert.deepEqual(m("`ls -la /some/path`"), ["c"]);
  assert.deepEqual(t("say **that again** please"), ["say ", "that again", " please"]);
  assert.deepEqual(m("say **that again** please"), ["-", "b", "-"]);
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

// 99-2: the block layer. `b` gives one entry per block as
// "<depth>:<joined text>", which is the shape MessageBody renders.
const b = (body: string) =>
  splitBodyBlocks(body, known).map((k) => `${k.depth}:${k.parts.map((p) => p.text).join("")}`);

test("a body with no quote line is one block at depth 0", () => {
  assert.deepEqual(b("just talking"), ["0:just talking"]);
  assert.deepEqual(b("two\nlines"), ["0:two\nlines"]);
  // And it is the same inline split the non-block path produces, so the
  // renderer's fast path and this one can never disagree about a plain body.
  assert.deepEqual(splitBodyBlocks("a *b* c", known)[0].parts, splitBodyNano("a *b* c", known));
});

test("a run of quoted lines is one block, markers gone", () => {
  assert.deepEqual(b("> alice wrote:\n> hello"), ["1:alice wrote:\nhello"]);
});

test("quoted and plain runs alternate, and the joining newline is dropped", () => {
  // The dropped "\n" is load-bearing: the caller renders each block as a
  // block-level element under white-space: pre-wrap, so keeping it would put
  // a blank line above every quote.
  assert.deepEqual(b("before\n> quoted\nafter"), ["0:before", "1:quoted", "0:after"]);
});

test("depth nests, and stops at the cap with the rest left literal", () => {
  assert.deepEqual(b("> a\n> > b"), ["1:a", "2:b"]);
  // Six markers, four levels: the cap nests four and the two it will not
  // nest stay literal text, rather than being eaten on the way past.
  assert.deepEqual(b(">".repeat(6) + "x"), [`${QUOTE_MAX_DEPTH}:>>x`]);
});

test("inline marks, mentions and links still work inside a quote", () => {
  const parts = splitBodyBlocks("> *hi* @alice https://x.example/p", known)[0].parts;
  assert.equal(parts.some((p) => p.italic), true);
  assert.equal(parts.some((p) => p.handle === "alice"), true);
  assert.equal(parts.some((p) => p.href === "https://x.example/p"), true);
});

test("a '>' that is not at the start of a line is ordinary text", () => {
  assert.deepEqual(b("2 > 1"), ["0:2 > 1"]);
  assert.deepEqual(b("a\n b > c"), ["0:a\n b > c"]);
});

test("no text is lost by the block split, only the markers", () => {
  // Newlines are excluded from the comparison because whether one survives
  // depends on whether it fell inside a run or between two; everything else
  // a sender wrote has to come out the other side.
  const peel = (line: string) => {
    let out = line;
    for (let d = quoteDepth(line); d > 0; d--) out = stripQuote(out);
    return out;
  };
  for (const body of ["> a\nb", ">\n> x", "> > deep", "a\n>b\nc", ">", ">>>>>>x"]) {
    const got = splitBodyBlocks(body, known)
      .flatMap((k) => k.parts.map((p) => p.text))
      .join("")
      .replace(/\n/g, "");
    const want = body.split("\n").map(peel).join("");
    assert.equal(got, want, JSON.stringify(body));
  }
});

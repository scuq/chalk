import { test } from "node:test";
import assert from "node:assert/strict";
import {
  QUOTE_MAX_CHARS,
  QUOTE_MAX_DEPTH,
  QUOTE_MAX_LINES,
  buildQuote,
  hasQuoteLine,
  quoteDepth,
  splitQuoteRuns,
  stripQuote,
} from "./quote.ts";
import { encodeGiphyBody } from "../giphy/giphy.ts";
import { encodeCodeBody } from "../code/code.ts";

const lines = (s: string) => s.split("\n");

test("a quote is the attribution line plus the body, all prefixed", () => {
  assert.deepEqual(lines(buildQuote("alice", "first\nsecond")), [
    "> alice wrote:",
    "> first",
    "> second",
  ]);
});

test("an empty body line becomes a bare '>' with no trailing space", () => {
  // Trailing whitespace on every blank line would survive into the sent
  // message, where it is invisible and impossible to explain.
  assert.deepEqual(lines(buildQuote("bob", "a\n\nb")), [
    "> bob wrote:",
    "> a",
    ">",
    "> b",
  ]);
});

test("quoting a quote nests instead of doubling up a stray marker", () => {
  const once = buildQuote("alice", "the deploy points at staging");
  const twice = buildQuote("bob", once);
  assert.deepEqual(lines(twice), [
    "> bob wrote:",
    "> > alice wrote:",
    "> > the deploy points at staging",
  ]);
  assert.equal(quoteDepth("> > alice wrote:"), 2);
});

test("there is nothing to quote in a body with no words", () => {
  // The menu gate depends on this: "" means don't offer the action.
  assert.equal(buildQuote("alice", ""), "");
  assert.equal(buildQuote("alice", "   \n\t "), "");
});

test("a gif has no text, a snippet quotes its caption", () => {
  // messageText, not clipboardText: quoting asks what someone SAID. A
  // snippet inside "> " would lose the framing that makes it readable.
  assert.equal(buildQuote("alice", encodeGiphyBody("https://media.example/x.gif")), "");
  const snippet = encodeCodeBody({ code: "x := 1", lang: "go" }, "look at this");
  assert.deepEqual(lines(buildQuote("alice", snippet)), [
    "> alice wrote:",
    "> look at this",
  ]);
});

test("a long message is clipped and says so", () => {
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const out = lines(buildQuote("alice", long));
  assert.equal(out.length, QUOTE_MAX_LINES + 2, "attribution, the cap, and the ellipsis");
  assert.equal(out.at(-1), "> …");
  assert.equal(out[1], "> line 0");
});

test("one enormous line is clipped by characters, not by lines", () => {
  const out = lines(buildQuote("alice", "x".repeat(QUOTE_MAX_CHARS * 3)));
  assert.equal(out.length, 3, "attribution, the clipped line, the ellipsis");
  assert.equal(out[1].length, QUOTE_MAX_CHARS + 2);
  assert.equal(out.at(-1), "> …");
});

test("a message that just fits is not clipped", () => {
  const body = Array.from({ length: QUOTE_MAX_LINES }, (_, i) => `l${i}`).join("\n");
  const out = lines(buildQuote("alice", body));
  assert.equal(out.length, QUOTE_MAX_LINES + 1);
  assert.ok(!out.includes("> …"));
});

test("depth counts levels with or without the space after each marker", () => {
  assert.equal(quoteDepth("plain"), 0);
  assert.equal(quoteDepth("> a"), 1);
  assert.equal(quoteDepth(">a"), 1);
  assert.equal(quoteDepth(">"), 1);
  assert.equal(quoteDepth("> > a"), 2);
  assert.equal(quoteDepth(">>a"), 2);
  assert.equal(quoteDepth(">> a"), 2);
});

test("a marker away from column 0 is ordinary text", () => {
  // No leading-space tolerance (Q0): indented prose must not become a quote
  // for the readers who turned the pref on and nobody else.
  assert.equal(quoteDepth(" > a"), 0);
  assert.equal(quoteDepth("a > b"), 0);
  assert.equal(quoteDepth("2 > 1"), 0);
});

test("depth stops counting at the cap", () => {
  assert.equal(quoteDepth(">".repeat(40)), QUOTE_MAX_DEPTH);
});

test("stripping removes exactly one level and leaves plain lines alone", () => {
  assert.equal(stripQuote("> a"), "a");
  assert.equal(stripQuote(">a"), "a");
  assert.equal(stripQuote(">"), "");
  assert.equal(stripQuote("> > a"), "> a");
  assert.equal(stripQuote("plain"), "plain");
  assert.equal(stripQuote(""), "");
});

test("runs alternate, and one level comes off the quoted ones", () => {
  assert.deepEqual(splitQuoteRuns(["a", "> b", "> c", "d"]), [
    { quoted: false, lines: ["a"] },
    { quoted: true, lines: ["b", "c"] },
    { quoted: false, lines: ["d"] },
  ]);
});

test("a blank line ends a run but a bare '>' does not", () => {
  assert.deepEqual(splitQuoteRuns(["> a", "", "> b"]), [
    { quoted: true, lines: ["a"] },
    { quoted: false, lines: [""] },
    { quoted: true, lines: ["b"] },
  ]);
  assert.deepEqual(splitQuoteRuns(["> a", ">", "> b"]), [
    { quoted: true, lines: ["a", "", "b"] },
  ]);
});

test("no lines, no runs", () => {
  assert.deepEqual(splitQuoteRuns([]), []);
});

test("the cheap guard agrees with the real parse", () => {
  for (const body of ["> a", "a\n> b", ">", "a > b", "plain", "", "2 > 1\n3 > 2"]) {
    const real = body.split("\n").some((l) => quoteDepth(l) > 0);
    assert.equal(hasQuoteLine(body), real, JSON.stringify(body));
  }
});

test("what buildQuote writes, splitQuoteRuns reads back", () => {
  const body = "first\n\nsecond line\nthird";
  const runs = splitQuoteRuns(lines(buildQuote("alice", body)));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].quoted, true);
  assert.deepEqual(runs[0].lines, ["alice wrote:", ...body.split("\n")]);
});

test("no text is invented or lost between the two directions", () => {
  const body = "a *b* `c` @alice https://x.example/p";
  const runs = splitQuoteRuns(lines(buildQuote("bob", body)));
  assert.equal(runs[0].lines.slice(1).join("\n"), body);
});

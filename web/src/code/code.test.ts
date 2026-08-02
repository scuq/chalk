import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODE_SENTINEL,
  CODE_MAX_CHARS,
  CODE_LANGS,
  encodeCodeBody,
  parseCodeBody,
  sanitizeCodePayload,
  codeLineCount,
  decideCodeRender,
} from "./code";

const SNIPPET = "func main() {\n\tfmt.Println(\"hi\")\n}";

// ---- marker encode/parse ----------------------------------------------

test("encode/parse round-trips the snippet and the caption", () => {
  const body = encodeCodeBody({ code: SNIPPET, lang: "go" }, "here's the fix:");
  assert.ok(body.startsWith(CODE_SENTINEL));
  assert.deepEqual(parseCodeBody(body), {
    payload: { code: SNIPPET, lang: "go" },
    text: "here's the fix:",
  });
});

test("a caption is optional", () => {
  const parsed = parseCodeBody(encodeCodeBody({ code: SNIPPET, lang: "go" }, ""));
  assert.equal(parsed?.text, "");
  assert.equal(parsed?.payload.code, SNIPPET);
});

test("parse returns null for a body that is not a code message", () => {
  assert.equal(parseCodeBody(""), null);
  assert.equal(parseCodeBody("just text"), null);
  assert.equal(parseCodeBody("\u0001chalk:giphy:v1\u0001https://media.giphy.com/a.gif"), null);
  // A future version must not be mistaken for this one.
  assert.equal(parseCodeBody("\u0001chalk:code:v2\u0001{}\u0001hi"), null);
});

test("parse returns null when the framing is truncated or corrupt", () => {
  assert.equal(parseCodeBody(CODE_SENTINEL + '{"code":"x"}'), null); // no terminator
  assert.equal(parseCodeBody(CODE_SENTINEL + "not json\u0001hi"), null);
  assert.equal(parseCodeBody(CODE_SENTINEL + "[1,2]\u0001hi"), null);
  assert.equal(parseCodeBody(CODE_SENTINEL + "null\u0001hi"), null);
});

// The reason the terminator scan is safe: a snippet may itself contain U+0001,
// but JSON.stringify escapes it, so the first raw one is always the terminator.
test("a snippet containing U+0001 survives the round trip", () => {
  const nasty = "a\u0001b\nc";
  const body = encodeCodeBody({ code: nasty, lang: "" }, "caption\u0001with one too");
  assert.deepEqual(parseCodeBody(body), {
    payload: { code: nasty, lang: "" },
    text: "caption\u0001with one too",
  });
});

test("encode degrades to the caption alone when the payload is unusable", () => {
  assert.equal(encodeCodeBody({ code: "   ", lang: "go" }, "hello"), "hello");
});

// ---- sanitize ----------------------------------------------------------

test("sanitize rejects anything without usable code", () => {
  assert.equal(sanitizeCodePayload(null), null);
  assert.equal(sanitizeCodePayload("x"), null);
  assert.equal(sanitizeCodePayload({}), null);
  assert.equal(sanitizeCodePayload({ code: 42 }), null);
  assert.equal(sanitizeCodePayload({ code: "" }), null);
  assert.equal(sanitizeCodePayload({ code: " \n\t " }), null);
});

test("sanitize keeps leading indentation", () => {
  const py = "def f():\n    return 1\n";
  assert.equal(sanitizeCodePayload({ code: py, lang: "python" })?.code, py);
});

test("sanitize normalizes CRLF so pasted Windows snippets don't double-space", () => {
  assert.equal(sanitizeCodePayload({ code: "a\r\nb\rc" })?.code, "a\nb\nc");
});

test("sanitize drops unknown fields", () => {
  const out = sanitizeCodePayload({ code: "x", lang: "go", filename: "main.go", evil: 1 });
  assert.deepEqual(out, { code: "x", lang: "go" });
});

test("sanitize accepts only allowlisted languages", () => {
  assert.equal(sanitizeCodePayload({ code: "x", lang: "TypeScript" })?.lang, "typescript");
  assert.equal(sanitizeCodePayload({ code: "x", lang: "  go  " })?.lang, "go");
  assert.equal(sanitizeCodePayload({ code: "x", lang: "brainfuck" })?.lang, "");
  assert.equal(sanitizeCodePayload({ code: "x", lang: 7 })?.lang, "");
  assert.equal(sanitizeCodePayload({ code: "x" })?.lang, "");
  assert.equal(sanitizeCodePayload({ code: "x", lang: "g".repeat(40) })?.lang, "");
});

test("every listed language survives sanitizing", () => {
  for (const lang of CODE_LANGS) {
    assert.equal(sanitizeCodePayload({ code: "x", lang })?.lang, lang);
  }
});

test("sanitize caps the code by code points", () => {
  const long = "a".repeat(CODE_MAX_CHARS + 500);
  assert.equal([...(sanitizeCodePayload({ code: long })?.code ?? "")].length, CODE_MAX_CHARS);
  // Astral characters count as one, and must not be sliced in half.
  const emoji = "😀".repeat(CODE_MAX_CHARS + 10);
  const capped = sanitizeCodePayload({ code: emoji })?.code ?? "";
  assert.equal([...capped].length, CODE_MAX_CHARS);
  assert.ok(!capped.endsWith("\uD83D")); // no lone surrogate
});

// ---- line count --------------------------------------------------------

test("codeLineCount ignores a trailing newline", () => {
  assert.equal(codeLineCount(""), 0);
  assert.equal(codeLineCount("one"), 1);
  assert.equal(codeLineCount("one\n"), 1);
  assert.equal(codeLineCount("one\ntwo"), 2);
  assert.equal(codeLineCount("one\ntwo\n"), 2);
  assert.equal(codeLineCount("one\n\nthree"), 3);
});

// ---- render decision ---------------------------------------------------

test("decideCodeRender classifies plain bodies as text", () => {
  assert.deepEqual(decideCodeRender("hello"), { mode: "text" });
  assert.deepEqual(decideCodeRender(CODE_SENTINEL + "garbage"), { mode: "text" });
});

test("decideCodeRender splits a code body into card and caption", () => {
  const body = encodeCodeBody({ code: SNIPPET, lang: "go" }, "look:");
  assert.deepEqual(decideCodeRender(body), {
    mode: "code",
    payload: { code: SNIPPET, lang: "go" },
    text: "look:",
  });
});

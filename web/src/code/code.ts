// 74-1: code-block support (client core).
//
// A code block is a snippet the sender pasted into the CODE modal, carried
// inside the normal E2E-encrypted body and rendered as a card: monospace,
// unwrapped, with a language label and a copy button. The server never sees
// anything but ciphertext, and rendering costs zero network requests -- so
// unlike Giphy there is no viewer consent gate, and unlike link previews
// there is nothing sender-asserted to distrust beyond the text itself.
//
// This module is the pure, framework-free core: the on-the-wire marker and
// payload schema, receive-side sanitizing, and the render decision. The
// components build on top (the modal + composer staging in 74-2, the card in
// 74-3).
//
// No syntax highlighting: `lang` is a cosmetic label only. That keeps the card
// identical across all of chalk's themes and adds no dependency. Highlighting,
// if it ever lands, is a render-side concern and needs nothing from this file.

// ---- on-the-wire marker + payload -------------------------------------

// CODE_SENTINEL prefixes the plaintext body of a message carrying a snippet.
// Same construction as GIPHY_SENTINEL and LINKPREVIEW_SENTINEL: U+0001
// controls bracket a version-tagged token, unambiguous against typed text. A
// snippet ACCOMPANIES a caption, so -- exactly like link previews -- the
// payload JSON is terminated by one more U+0001 and the user's text follows:
//
// Wire form:  \u0001chalk:code:v1\u0001<payload json>\u0001<text>
//
// JSON.stringify escapes control characters, so the payload can never contain
// a literal U+0001 -- the terminator scan is unambiguous. That matters more
// here than it did for link previews: a pasted snippet is arbitrary text and
// could genuinely contain one.
export const CODE_SENTINEL = "\u0001chalk:code:v1\u0001";

// Caps applied on BOTH encode and parse: the payload arrives inside E2E
// ciphertext, so the server never had a chance to bound what a sender
// embedded. 20k code points stays far under the 1 MiB frame ceiling
// (proto.MaxFrameBytes) even after JSON escaping and the base64 of the
// ciphertext.
export const CODE_MAX_CHARS = 20000;
export const CODE_MAX_LANG = 32;

// CODE_LANGS is the label allowlist. Purely cosmetic -- nothing branches on
// it -- so extending it is a one-line change with no other consequence. A
// value outside the list degrades to "" and the card simply shows no label,
// rather than printing whatever string a sender chose into the header.
export const CODE_LANGS = [
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "diff",
  "dockerfile",
  "go",
  "html",
  "java",
  "javascript",
  "json",
  "kotlin",
  "lua",
  "makefile",
  "nix",
  "php",
  "python",
  "ruby",
  "rust",
  "sql",
  "swift",
  "toml",
  "typescript",
  "xml",
  "yaml",
  "zig",
] as const;

const CODE_LANG_SET = new Set<string>(CODE_LANGS);

export interface CodePayload {
  code: string;
  lang: string; // "" = unlabelled
}

// encodeCodeBody builds the plaintext body for a message carrying a snippet.
// The caller encrypts the result exactly like any other body. An unusable
// payload degrades to the caption alone rather than sending broken framing.
export function encodeCodeBody(payload: CodePayload, text: string): string {
  const clean = sanitizeCodePayload(payload);
  if (!clean) return text;
  return CODE_SENTINEL + JSON.stringify(clean) + "\u0001" + text;
}

// parseCodeBody returns the embedded snippet + the accompanying text if body
// carries one, else null (callers render body as plain text).
export function parseCodeBody(body: string): { payload: CodePayload; text: string } | null {
  if (!body.startsWith(CODE_SENTINEL)) return null;
  const rest = body.slice(CODE_SENTINEL.length);
  const end = rest.indexOf("\u0001");
  if (end < 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(rest.slice(0, end));
  } catch {
    return null;
  }
  const payload = sanitizeCodePayload(raw);
  if (!payload) return null;
  return { payload, text: rest.slice(end + 1) };
}

// sanitizeCodePayload validates a sender-asserted payload into a well-formed
// one, or null if there is no snippet to show. Unknown fields are dropped and
// the code is capped, so a hostile payload degrades to plain text rather than
// to broken UI.
//
// Whitespace is NOT trimmed from the code: leading indentation is part of a
// snippet, and stripping it would silently mangle Python. Only the
// all-whitespace case is rejected, since an empty card is not worth a row.
export function sanitizeCodePayload(raw: unknown): CodePayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.code !== "string") return null;
  const code = capCode(normalizeNewlines(o.code));
  if (code.trim() === "") return null;

  return { code, lang: cleanLang(o.lang) };
}

// A textarea yields \n, but a snippet pasted from a Windows editor can arrive
// with \r\n and would then render a blank line between every line of code.
function normalizeNewlines(s: string): string {
  return s.replace(/\r\n?/g, "\n");
}

// Capped by code points (not UTF-16 units) so a snippet full of emoji or CJK
// is measured the way the modal's counter shows it.
function capCode(s: string): string {
  const cp = [...s];
  return cp.length <= CODE_MAX_CHARS ? s : cp.slice(0, CODE_MAX_CHARS).join("");
}

function cleanLang(v: unknown): string {
  if (typeof v !== "string") return "";
  const t = v.trim().toLowerCase();
  if (t.length > CODE_MAX_LANG) return "";
  return CODE_LANG_SET.has(t) ? t : "";
}

// codeLineCount is what the card's header and the composer's staged chip both
// report, so the two can never disagree. A trailing newline is not a line.
export function codeLineCount(code: string): number {
  if (code === "") return 0;
  return code.replace(/\n$/, "").split("\n").length;
}

// ---- render decision ---------------------------------------------------

export type CodeRender =
  | { mode: "text" } // not a code message: render body as plain text
  | { mode: "code"; payload: CodePayload; text: string };

// decideCodeRender classifies a received body. No viewer gate: the card is
// built entirely from decrypted data and fetches nothing. A corrupt or
// hostile payload falls back to "text", where the raw body renders as-is.
export function decideCodeRender(body: string): CodeRender {
  const parsed = parseCodeBody(body);
  if (!parsed) return { mode: "text" };
  return { mode: "code", payload: parsed.payload, text: parsed.text };
}

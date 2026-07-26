// Finding http(s) URLs in a message body, and splitting a body into the
// pieces the renderer needs (plain text, mentions, links).
//
// Bodies are ciphertext to the server, so this -- like mention parsing --
// happens entirely on this side of the wire. Nothing about a link is known
// to anyone without the channel key.
//
// Only http and https are recognised. That is the whole allow-list, and it
// is deliberate: the pattern cannot match "javascript:", "data:" or "file:"
// at all, so the usual way a chat client turns a pasted string into script
// execution does not exist here.

import { findMentions, splitBodyMentions, type BodySegment } from "./mentions";

// A URL runs until whitespace. Angle brackets and quotes end it too: they
// are what people wrap a URL in ("see <https://x.example/>"), never part of
// one in practice.
const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;

// Sentence punctuation that a URL at the end of a sentence collects but does
// not own. "read https://x.example/page." links the page, not the full stop.
const TRAILING_PUNCT = ".,;:!?'\"";

const CLOSERS: Record<string, string> = { ")": "(", "]": "[", "}": "{" };

/** Drop trailing characters the writer meant as prose, not as URL.
 *
 *  Brackets are counted rather than stripped outright, because they are
 *  genuinely common inside URLs -- a Wikipedia article like
 *  .../Foo_(disambiguation) ends in a ")" that belongs to the link. Only an
 *  unbalanced closer is prose. */
function trimTrailing(raw: string): string {
  let s = raw;
  for (;;) {
    const last = s.at(-1);
    if (last === undefined) break;
    if (TRAILING_PUNCT.includes(last)) {
      s = s.slice(0, -1);
      continue;
    }
    const open = CLOSERS[last];
    if (open) {
      const closes = s.split(last).length - 1;
      const opens = s.split(open).length - 1;
      if (closes > opens) {
        s = s.slice(0, -1);
        continue;
      }
    }
    break;
  }
  return s;
}

/** The href to use for a matched string, or null if it isn't one we open.
 *
 *  The regex already guarantees an http(s) scheme; parsing again is what
 *  rejects the malformed leftovers it can still match ("https://", a URL
 *  with no host). The raw text becomes the href rather than URL.href, so
 *  what the user clicks is exactly what they see -- no silent normalising
 *  of a link someone is reading off the screen. */
export function linkHref(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return raw;
  } catch {
    return null;
  }
}

export interface LinkSpan {
  start: number;
  end: number;
  href: string;
}

/** Every http(s) URL in a body, in order, as half-open [start, end) ranges. */
export function findLinks(body: string): LinkSpan[] {
  const out: LinkSpan[] = [];
  for (const m of body.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    const raw = trimTrailing(m[0]);
    const href = raw ? linkHref(raw) : null;
    if (!href) continue;
    out.push({ start, end: start + raw.length, href });
  }
  return out;
}

/** One piece of a body, ready to render. At most one of `handle` / `href`
 *  is set; neither means literal text. */
export interface BodyPart extends BodySegment {
  href?: string;
}

/** Split a body into text, mention and link pieces.
 *
 *  Links are found first and win any overlap, because a URL can contain
 *  something that reads exactly like a mention -- https://x.example/@alice
 *  is one link, not a link plus a mention of alice. */
export function splitBodyParts(body: string, known: Set<string>): BodyPart[] {
  const links = findLinks(body);
  if (links.length === 0) return splitBodyMentions(body, known);

  // Blank each URL out with word characters before scanning for mentions.
  // Word characters specifically: the mention pattern treats a non-word
  // character as a boundary, so masking with anything else would let the
  // token straight after a URL read as a mention when it does not in the
  // real body.
  let masked = body;
  for (const l of links) {
    masked = masked.slice(0, l.start) + "x".repeat(l.end - l.start) + masked.slice(l.end);
  }

  const spans = [
    ...links.map((l) => ({ start: l.start, end: l.end, href: l.href, handle: undefined })),
    ...findMentions(masked, known).map((m) => ({
      start: m.start,
      end: m.end,
      href: undefined,
      handle: m.handle,
    })),
  ].sort((a, b) => a.start - b.start);

  const parts: BodyPart[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start > cursor) parts.push({ text: body.slice(cursor, s.start) });
    parts.push({ text: body.slice(s.start, s.end), handle: s.handle, href: s.href });
    cursor = s.end;
  }
  if (cursor < body.length) parts.push({ text: body.slice(cursor) });
  return parts;
}

// 77-1: nano markdown -- `code`, **bold** and *italic*.
//
// 107-2: and one block construct, quoted lines, added by splitBodyBlocks at
// the bottom of this file. Everything between here and there is the inline
// scan, which quoting did not touch: it still sees one run of lines at a
// time and still knows nothing about "> ".
//
// This is a receive-side, opt-in reading aid. Nothing here runs on the send
// side: the composer never rewrites or previews anything, so the literal
// characters always go over the wire, and a reader who has the pref off sees
// exactly what was typed. That asymmetry is the whole design.
//
// Composition with chat/links.ts: URLs are masked before the delimiter scan,
// the same trick splitBodyParts uses before it scans for mentions. A "*"
// inside a URL is therefore never a delimiter, and URL_RE cannot match a
// backtick at all -- so no chunk boundary can ever land inside a link. That
// invariant is what lets the second pass hand each non-code chunk straight to
// splitBodyParts: links and mentions are found by the existing code, on
// substrings it would have split identically anyway.
//
// The rules, in full:
//
//   R0  Nothing crosses a newline. An unterminated backtick can spoil at most
//       its own line.
//   R1  Code is found first and is an atom: "`" to the next "`" on the same
//       line, non-empty interior, never scanned for anything else. The
//       emphasis walk steps over a code span whole, so `**a `b` c**` bolds
//       all three pieces.
//   R2  A "*" run opens only when the character after it is not whitespace,
//       and closes only when the character before it is not whitespace.
//   R3  Emphasis wraps whole words: a run opens at the start of a line or
//       after whitespace or an opening bracket, and closes at the end of a
//       line or before whitespace or sentence punctuation. This is what keeps
//       "2*3*4", "snake*case*thing" and "rm *.txt *.log" as prose. The price
//       is that "**bold**ish" does not render, which nobody types in chat.
//   R4  The run length is the mark: one "*" is italic, two bold, three both,
//       four or more literal. Opener and closer must be the same length. An
//       unmatched run is literal text.
//   R5  No escapes. Not just for brevity: the pref is per-reader and defaults
//       off, so a "\*" typed by a sender would show as a stray backslash to
//       everyone who has not turned it on. An escape here would corrupt the
//       plain text for the majority to serve the minority.

import { findLinks, splitBodyParts, type BodyPart } from "./links";
import { QUOTE_MAX_DEPTH, hasQuoteLine, splitQuoteRuns } from "./quote";

/** One piece of a body, ready to render: the plain/mention/link piece
 *  chat/links.ts produces, plus the marks wrapped around it. */
export interface NanoPart extends BodyPart {
  code?: boolean;
  bold?: boolean;
  italic?: boolean;
}

interface Marks {
  bold?: boolean;
  italic?: boolean;
}

// A run of body between delimiters, carrying the emphasis in force there.
interface Chunk extends Marks {
  start: number;
  end: number;
}

// Characters a run may open right after, beyond whitespace and line start.
const OPEN_BEFORE = "([{\"'";

// Characters a run may close right before, beyond whitespace and line end.
const CLOSE_AFTER = ".,;:!?)]}\"'";

function isSpace(c: string | undefined): boolean {
  return c === undefined || c === " " || c === "\t" || c === "\n" || c === "\r";
}

/** The body with every link blanked out to same-length filler, so a "*" that
 *  is part of a URL cannot be read as a delimiter. */
function maskLinks(body: string): string {
  let masked = body;
  for (const l of findLinks(body)) {
    masked = masked.slice(0, l.start) + "x".repeat(l.end - l.start) + masked.slice(l.end);
  }
  return masked;
}

/** Code spans in one line, as opening-backtick index -> index just past the
 *  closing backtick. An empty pair renders as text: the first backtick is
 *  left literal and the second is free to open a span of its own. */
function findCodeSpans(mask: string, from: number, to: number, out: Map<number, number>): void {
  let i = from;
  while (i < to) {
    if (mask[i] !== "`") {
      i++;
      continue;
    }
    const close = mask.indexOf("`", i + 1);
    if (close < 0 || close >= to) return;
    if (close === i + 1) {
      i++;
      continue;
    }
    out.set(i, close + 1);
    i = close + 1;
  }
}

function starRun(mask: string, i: number, to: number): number {
  let n = 0;
  while (i + n < to && mask[i + n] === "*") n++;
  return n;
}

function opens(mask: string, i: number, run: number, from: number, to: number): boolean {
  if (i + run >= to || isSpace(mask[i + run])) return false;
  if (i === from) return true;
  const before = mask[i - 1];
  return isSpace(before) || OPEN_BEFORE.includes(before);
}

function closes(mask: string, i: number, run: number, to: number): boolean {
  if (isSpace(mask[i - 1])) return false;
  if (i + run >= to) return true;
  const after = mask[i + run];
  return isSpace(after) || CLOSE_AFTER.includes(after);
}

/** The index of the run that closes an opener of `run` stars, or -1. */
function findCloser(
  mask: string,
  start: number,
  to: number,
  run: number,
  code: Map<number, number>,
): number {
  let i = start;
  while (i < to) {
    const codeEnd = code.get(i);
    if (codeEnd !== undefined) {
      i = codeEnd;
      continue;
    }
    if (mask[i] !== "*") {
      i++;
      continue;
    }
    const r = starRun(mask, i, to);
    if (r === run && i > start && closes(mask, i, r, to)) return i;
    i += r;
  }
  return -1;
}

function withRun(marks: Marks, run: number): Marks {
  return {
    bold: marks.bold || run >= 2,
    italic: marks.italic || run === 1 || run === 3,
  };
}

/** Cut [from, to) into chunks, dropping the emphasis delimiters and carrying
 *  the marks in force. Recurses into a matched span's interior, which is
 *  always strictly shorter, so it terminates. */
function scanEmphasis(
  mask: string,
  from: number,
  to: number,
  code: Map<number, number>,
  marks: Marks,
  out: Chunk[],
): void {
  let cursor = from;
  let i = from;
  while (i < to) {
    const codeEnd = code.get(i);
    if (codeEnd !== undefined) {
      i = codeEnd;
      continue;
    }
    if (mask[i] !== "*") {
      i++;
      continue;
    }
    const run = starRun(mask, i, to);
    const close =
      run <= 3 && opens(mask, i, run, from, to) ? findCloser(mask, i + run, to, run, code) : -1;
    if (close < 0) {
      i += run;
      continue;
    }
    if (i > cursor) out.push({ start: cursor, end: i, ...marks });
    scanEmphasis(mask, i + run, close, code, withRun(marks, run), out);
    i = close + run;
    cursor = i;
  }
  if (cursor < to) out.push({ start: cursor, end: to, ...marks });
}

/** Join chunks that touch and carry the same marks. Scanning is per line, so
 *  a plain three-line body arrives here as three chunks; merging them keeps a
 *  body whose markers all failed to pair rendering as one text node, exactly
 *  as it does without the pref. */
function merge(chunks: Chunk[]): Chunk[] {
  const out: Chunk[] = [];
  for (const c of chunks) {
    const last = out.at(-1);
    if (last && last.end === c.start && !last.bold === !c.bold && !last.italic === !c.italic) {
      last.end = c.end;
      continue;
    }
    out.push({ ...c });
  }
  return out;
}

/** Split one chunk into its code spans and the prose around them. Code is
 *  emitted verbatim -- it never reaches splitBodyParts, which is what keeps
 *  an @mention or a URL inside backticks literal. */
function emitChunk(
  body: string,
  chunk: Chunk,
  code: Map<number, number>,
  known: Set<string>,
  out: NanoPart[],
): void {
  const prose = (start: number, end: number) => {
    for (const part of splitBodyParts(body.slice(start, end), known)) {
      out.push({ ...part, bold: chunk.bold, italic: chunk.italic });
    }
  };

  let cursor = chunk.start;
  let i = chunk.start;
  while (i < chunk.end) {
    const codeEnd = code.get(i);
    if (codeEnd === undefined) {
      i++;
      continue;
    }
    if (i > cursor) prose(cursor, i);
    out.push({
      text: body.slice(i + 1, codeEnd - 1),
      code: true,
      bold: chunk.bold,
      italic: chunk.italic,
    });
    i = codeEnd;
    cursor = codeEnd;
  }
  if (cursor < chunk.end) prose(cursor, chunk.end);
}

/** Split a body into pieces for rendering, honouring the three nano-markdown
 *  constructs. A body with no delimiter in it is handed straight to
 *  splitBodyParts, so the common case costs nothing over the plain path. */
export function splitBodyNano(body: string, known: Set<string>): NanoPart[] {
  if (!body.includes("*") && !body.includes("`")) return splitBodyParts(body, known);

  const mask = maskLinks(body);
  const code = new Map<number, number>();
  const chunks: Chunk[] = [];
  let from = 0;
  for (;;) {
    const nl = mask.indexOf("\n", from);
    const to = nl < 0 ? mask.length : nl + 1;
    findCodeSpans(mask, from, to, code);
    scanEmphasis(mask, from, to, code, {}, chunks);
    if (nl < 0) break;
    from = to;
  }

  const parts: NanoPart[] = [];
  for (const chunk of merge(chunks)) emitChunk(body, chunk, code, known, parts);
  return parts;
}

/** One block of a body: a run of lines at the same quote depth, already
 *  split into inline pieces. Depth 0 is ordinary prose. */
export interface NanoBlock {
  depth: number;
  parts: NanoPart[];
}

/** 107-2: the body as blocks, honouring quoted lines on top of the three
 *  inline marks.
 *
 * A layer ABOVE splitBodyNano, not a change to it. The inline scan is
 * per-line by construction (R0) and merge() joins chunks across newlines, so
 * a block flag threaded through it would have to survive a merge that is
 * deliberately blind to line boundaries. Splitting into runs first and
 * handing each run to the unchanged scanner keeps both jobs simple, and
 * costs one extra pass over the lines on the bodies that have a "> " in them
 * at all.
 *
 * The newline that SEPARATES two blocks is dropped: the caller renders each
 * block as a block-level element, which supplies that break itself, and
 * .chalk-message-body is white-space: pre-wrap, so keeping it would show as a
 * blank line above every quote. Newlines *inside* a run are kept. */
export function splitBodyBlocks(body: string, known: Set<string>): NanoBlock[] {
  if (!hasQuoteLine(body)) return [{ depth: 0, parts: splitBodyNano(body, known) }];
  return blocksOf(body.split("\n"), 0, known);
}

function blocksOf(lines: string[], depth: number, known: Set<string>): NanoBlock[] {
  // The cap is checked BEFORE splitting, not after: splitQuoteRuns strips a
  // level as it groups, so testing it on the way out would eat one marker
  // more than it nested and leave the deepest quote a ">" short.
  if (depth >= QUOTE_MAX_DEPTH) {
    return [{ depth, parts: splitBodyNano(lines.join("\n"), known) }];
  }
  const out: NanoBlock[] = [];
  for (const run of splitQuoteRuns(lines)) {
    if (run.quoted) {
      out.push(...blocksOf(run.lines, depth + 1, known));
      continue;
    }
    out.push({ depth, parts: splitBodyNano(run.lines.join("\n"), known) });
  }
  return out;
}

/** The body as it reads with the markers applied but no styling available --
 *  for the one-line previews that are plain strings and cannot host
 *  elements. */
export function stripNanoMarks(body: string, known: Set<string>): string {
  return splitBodyNano(body, known)
    .map((p) => p.text)
    .join("");
}

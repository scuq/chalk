// 107-1: quoting a message -- the "> " rules, both directions.
//
// Two halves that have to agree, which is why they live in one file:
//
//   buildQuote      makes the text the composer receives when you pick
//                   "quote" on a row. It runs once, on a user action, and
//                   what it produces is ordinary editable draft text.
//   splitQuoteRuns  reads "> " back on the receive side, for the reader who
//                   turned nano markdown on.
//
// The send side never rewrites anything at send time -- phase 77's asymmetry
// holds. buildQuote is not a transformation applied to your message; it is a
// paste. You can see every character it inserted, edit them, or delete them,
// and the wire carries exactly what is in the box. A reader with the pref off
// sees "> alice wrote:" in plain characters, which still reads as a quote.
//
// The rules, in full:
//
//   Q0  A quote line starts with ">" at column 0. No leading-space
//       tolerance: real markdown allows up to three, but buildQuote never
//       emits them, and accepting them would make an indented code-ish line
//       silently become a quote for readers with the pref on and not for
//       anyone else.
//   Q1  One level is ">" plus AT MOST one following space, and the space is
//       consumed. So "> a" and ">a" are both depth 1 over "a", and "> > a"
//       and ">>a" are both depth 2. This is what makes quoting a quote nest
//       instead of producing a line that starts with a stray ">".
//   Q2  Depth is capped at QUOTE_MAX_DEPTH on parse, not just on build. The
//       sender's bytes are not trusted to bound our DOM -- same reasoning as
//       the link-preview cap re-applied in linkpreview.ts.
//   Q3  A run of quoted lines is one block. A line that is not quoted ends
//       it, including an empty one; ">" alone is a quoted empty line and
//       stays inside the block.
//   Q4  buildQuote truncates. A 4000-character message quoted whole would
//       fill the composer's own cap and leave no room for the answer, so the
//       quote stops at QUOTE_MAX_LINES or QUOTE_MAX_CHARS and says so with a
//       final "> …" rather than trailing off silently.

import { messageText } from "./bodytext";

/** What one level of quoting looks like on the way out. */
export const QUOTE_PREFIX = "> ";

/** How deep nesting renders before further ">" stay literal text (Q2). */
export const QUOTE_MAX_DEPTH = 4;

/** Most body lines one "quote" pick will carry into the composer (Q4). */
export const QUOTE_MAX_LINES = 12;

/** Most body characters one "quote" pick will carry (Q4). */
export const QUOTE_MAX_CHARS = 800;

/** The line that stands in for what the cap dropped. */
const ELLIPSIS_LINE = "…";

/** How many "> " levels this line opens with, capped at QUOTE_MAX_DEPTH.
 *  Zero means it is not a quote line at all. */
export function quoteDepth(line: string): number {
  let i = 0;
  let depth = 0;
  while (depth < QUOTE_MAX_DEPTH && line[i] === ">") {
    i++;
    if (line[i] === " ") i++;
    depth++;
  }
  return depth;
}

/** The line with ONE level of quoting removed (Q1). A line that is not
 *  quoted comes back unchanged, so this is safe to call on anything. */
export function stripQuote(line: string): string {
  if (line[0] !== ">") return line;
  return line.slice(line[1] === " " ? 2 : 1);
}

/** One run of consecutive lines that are all quoted or all not. `quoted`
 *  lines have had one level stripped, so the caller recurses on them. */
export interface QuoteRun {
  quoted: boolean;
  lines: string[];
}

/** Group lines into alternating quoted / unquoted runs (Q3).
 *
 * Only one level is peeled here. A caller that wants the whole tree calls
 * itself on a quoted run's lines; each recursion strips a level, so
 * quoteDepth's cap bounds the depth and the run being non-empty bounds the
 * breadth. Returns [] for no lines at all. */
export function splitQuoteRuns(lines: string[]): QuoteRun[] {
  const runs: QuoteRun[] = [];
  for (const line of lines) {
    const quoted = quoteDepth(line) > 0;
    const last = runs.at(-1);
    if (last && last.quoted === quoted) {
      last.lines.push(quoted ? stripQuote(line) : line);
      continue;
    }
    runs.push({ quoted, lines: [quoted ? stripQuote(line) : line] });
  }
  return runs;
}

/** Does this body contain a quote line at all? The cheap guard the renderer
 *  uses before doing any block work. */
export function hasQuoteLine(body: string): boolean {
  if (!body.includes(">")) return false;
  return body[0] === ">" || body.includes("\n>");
}

/** The text a "quote" pick puts in the composer: an attribution line and the
 *  message, every line prefixed.
 *
 * The body goes through messageText, not clipboardText: quoting asks "what
 * did this person say", so a gif contributes nothing (and yields "", meaning
 * the caller should not offer the action at all) and a code message
 * contributes its caption rather than the snippet -- a snippet inside "> "
 * would lose the very framing that makes it readable.
 *
 * Already-quoted lines get another "> ", which is exactly how nesting is
 * meant to happen (Q1). */
export function buildQuote(sender: string, body: string): string {
  const text = messageText(body);
  if (text.trim() === "") return "";

  const lines: string[] = [`${sender} wrote:`];
  let budget = QUOTE_MAX_CHARS;
  let clipped = false;
  for (const line of text.split("\n")) {
    if (lines.length > QUOTE_MAX_LINES || budget <= 0) {
      clipped = true;
      break;
    }
    if (line.length > budget) {
      lines.push(line.slice(0, budget));
      clipped = true;
      break;
    }
    lines.push(line);
    budget -= line.length;
  }
  if (clipped) lines.push(ELLIPSIS_LINE);

  return lines.map((l) => (l === "" ? ">" : QUOTE_PREFIX + l)).join("\n");
}

// Phase 56-1: @mention autocomplete for the composer.
//
// Pure draft-text logic only -- the popup UI lives in Composer.tsx. Kept
// separate from mentions.ts because that file answers "what does a finished
// body mention?" while this one answers "what is the user in the middle of
// typing?", and the two have different edge rules: a finished mention needs
// 3+ characters (MENTION_RE), but completion must engage from the bare "@"
// or nobody discovers the feature.

// The boundary rule mirrors MENTION_RE in mentions.ts: an "@" glued to a
// word character or another "@" (foo@bar, @@x) is not the start of a
// mention, so it must not pop the completion list either.
const TOKEN_CHAR = /[A-Za-z0-9_]/;

// An @token the caret is currently at the end of, as a half-open range
// starting at the "@". `prefix` is what follows the "@" (may be empty --
// a freshly typed "@" offers the whole roster).
export interface MentionToken {
  start: number;
  prefix: string;
}

// activeMentionToken finds the partial mention the caret sits after, or null.
// Only a caret at the END of the token counts: arrowing left into the middle
// of a handle should not resurface the popup over text the user is merely
// revisiting.
export function activeMentionToken(text: string, caret: number): MentionToken | null {
  if (caret < 1 || caret > text.length) return null;
  // The character at the caret must not extend the token -- otherwise we'd
  // be completing from the middle of a word.
  if (caret < text.length && TOKEN_CHAR.test(text[caret])) return null;
  let at = -1;
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      at = i;
      break;
    }
    if (!TOKEN_CHAR.test(ch)) return null;
  }
  if (at === -1) return null;
  const prefix = text.slice(at + 1, caret);
  if (prefix.length > 32) return null; // longer than any legal handle
  const before = at > 0 ? text[at - 1] : "";
  if (before && (TOKEN_CHAR.test(before) || before === "@")) return null;
  return { start: at, prefix };
}

// matchMentionHandles ranks the roster against a typed prefix: prefix
// matches first, then substring matches, each group alphabetical. Handles
// are folded to lower case and de-duplicated; matching is case-insensitive
// because people type @Alice.
export function matchMentionHandles(prefix: string, handles: string[]): string[] {
  const want = prefix.toLowerCase();
  const seen = new Set<string>();
  const starts: string[] = [];
  const contains: string[] = [];
  for (const raw of handles) {
    const h = raw.toLowerCase();
    if (seen.has(h)) continue;
    seen.add(h);
    if (h.startsWith(want)) starts.push(h);
    else if (want && h.includes(want)) contains.push(h);
  }
  starts.sort();
  contains.sort();
  return starts.concat(contains);
}

// applyMention splices the chosen handle over the partial token, with a
// trailing space so typing continues naturally after the completed mention.
export function applyMention(
  text: string,
  token: MentionToken,
  caret: number,
  handle: string,
): { value: string; caret: number } {
  const inserted = "@" + handle + " ";
  const value = text.slice(0, token.start) + inserted + text.slice(caret);
  return { value, caret: token.start + inserted.length };
}

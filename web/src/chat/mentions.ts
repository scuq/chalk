// Phase 33-3: @mention parsing.
//
// Mentions are derived entirely on this side of the wire. Message bodies
// are ciphertext to the server, and we deliberately chose not to have the
// sender leak a plaintext mention list alongside them, so nothing but a
// client holding the channel key can know who a message names.
//
// Two consequences worth remembering:
//   * A mention badge only reflects messages this client has decrypted.
//     App.tsx backfills by scanning recent history on connect; anything
//     older than that window is not flagged.
//   * There is no server-side mention record to build push notifications
//     on. That would require the metadata leak we declined.

// Handles are `^[a-z0-9_]{3,32}$` server-side (internal/auth/reserved.go).
// We match mixed case and fold it, because people type @Alice.
//
// The leading group consumes one character rather than using a lookbehind,
// which keeps this working on older Safari. It excludes "@" so an address
// like foo@bar.com can't read as a mention of "bar", and excludes word
// characters so "email@alice" doesn't either.
const MENTION_RE = /(^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{3,32})(?![A-Za-z0-9_])/g;

// One piece of a body split for rendering. `handle` is set only on pieces
// that are a mention of a known member; everything else is literal text
// (including @tokens that match nobody -- those must not look clickable).
export interface BodySegment {
  text: string;
  handle?: string;
}

// mentionedHandles returns the lowercased, de-duplicated handles a body
// names. Does not check membership -- callers that care pass the result
// through their own roster.
export function mentionedHandles(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    const handle = m[2].toLowerCase();
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push(handle);
  }
  return out;
}

// mentionsHandle reports whether a body names the given handle.
export function mentionsHandle(body: string, handle: string): boolean {
  if (!handle) return false;
  const want = handle.toLowerCase();
  return mentionedHandles(body).some((h) => h === want);
}

// Where a mention of a known member sits in a body, as a half-open range.
export interface MentionSpan {
  start: number;
  end: number;
  handle: string;
}

// findMentions locates mentions of `known` members. Positions rather than
// text, so a caller that also marks up other things (links, chat/links.ts)
// can merge both sets in one pass over the body.
export function findMentions(body: string, known: Set<string>): MentionSpan[] {
  const out: MentionSpan[] = [];
  for (const m of body.matchAll(MENTION_RE)) {
    const handle = m[2].toLowerCase();
    if (!known.has(handle)) continue;
    // m.index points at the boundary character the pattern consumed, not
    // at the "@". The token itself starts after it.
    const start = (m.index ?? 0) + m[1].length;
    out.push({ start, end: start + 1 + m[2].length, handle });
  }
  return out;
}

// splitBodyMentions splits a body into literal and mention segments for
// rendering. `known` is the set of lowercased handles that are members of
// the channel; a token naming anyone else stays plain text.
//
// Returns a single literal segment when there is nothing to highlight, so
// the common case costs one array allocation.
export function splitBodyMentions(body: string, known: Set<string>): BodySegment[] {
  const spans = findMentions(body, known);
  if (spans.length === 0) return [{ text: body }];
  const segments: BodySegment[] = [];
  let cursor = 0;
  for (const s of spans) {
    if (s.start > cursor) segments.push({ text: body.slice(cursor, s.start) });
    segments.push({ text: body.slice(s.start, s.end), handle: s.handle });
    cursor = s.end;
  }
  if (cursor < body.length) segments.push({ text: body.slice(cursor) });
  return segments;
}

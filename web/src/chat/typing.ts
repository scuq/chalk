// chalk-web -- who is typing, and how do you say it?
//
// Pure, on the threadinbox.ts precedent: the expiry arithmetic and the
// sentence-building are the parts that are fiddly to get right and tedious to
// check by hand in a browser. Neither needs app state, so neither imports it.
// The timer that drives them lives in typing-store.ts.

// How long a typist stays named after their last ping, and how often a client
// re-pings while composing. The ratio matters more than either number: at
// 7:3 two consecutive pings can be lost before a name disappears from under
// someone who is still typing.
//
// There is no stop frame in the protocol, so the TTL is also what clears a
// name when someone walks away mid-sentence -- which is why it is seconds and
// not minutes.
export const TYPING_TTL_MS = 7000;
export const TYPING_PING_MS = 3000;

// Above this many names the line stops naming anyone. Five is where a list
// of handles stops being readable at a glance.
export const TYPING_MAX_NAMES = 5;

// liveTypists returns the ids in entries that have not yet expired, in
// insertion order. An entry expires the instant it reaches its deadline.
export function liveTypists(entries: Map<string, number>, nowMs: number): string[] {
  const out: string[] = [];
  for (const [id, expiresAt] of entries) {
    if (expiresAt > nowMs) out.push(id);
  }
  return out;
}

// A piece of the rendered line. handle is set when the piece IS someone's
// name, so the UI can tint it the way the message feed tints the same person,
// and null for the punctuation between names.
export interface TypingSegment {
  text: string;
  handle: string | null;
}

// typingSegments turns resolved handles into the pieces of the line shown
// above the composer. Empty when there is nothing to say.
//
// Callers pass handles they could actually resolve, with themselves already
// removed. That has a visible consequence worth knowing about: the threshold
// counts the names YOU can see, so in a busy channel one person may read five
// names while everyone else reads the crowd line. This is why the crowd line
// carries no number -- "6 people are typing" would be plainly wrong to the one
// person who isn't counted among them.
export function typingSegments(handles: string[]): TypingSegment[] {
  if (handles.length === 0) return [];
  if (handles.length > TYPING_MAX_NAMES) {
    return [{ text: "many keyboards are on fire 🔥", handle: null }];
  }
  const out: TypingSegment[] = [];
  handles.forEach((handle, i) => {
    if (i > 0) out.push({ text: i === handles.length - 1 ? " and " : ", ", handle: null });
    out.push({ text: handle, handle });
  });
  out.push({ text: handles.length === 1 ? " is typing..." : " are typing...", handle: null });
  return out;
}

// formatTypingLine is typingSegments as plain text, or null when there is
// nothing to say. The untinted form, and what the tests read.
export function formatTypingLine(handles: string[]): string | null {
  const segments = typingSegments(handles);
  if (segments.length === 0) return null;
  return segments.map((s) => s.text).join("");
}

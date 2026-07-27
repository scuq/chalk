// 49-1: a thread's title is its head message, compressed to one line.
//
// Bodies are E2E-encrypted, so the title can only ever be derived
// client-side from an already-decrypted body -- there is no server-side
// title field and there must not be one. Callers pass whatever decrypted
// head body they hold (channel cache or thread-inbox preview) and fall
// back to a generic label when this returns null.

export const THREAD_TITLE_MAX = 48;

// Collapse whitespace, trim, clip at a word boundary. Returns null for
// nothing usable: body not decrypted yet (undefined) or empty once
// flattened (attachment-only messages).
export function threadTitle(
  body: string | undefined,
  max = THREAD_TITLE_MAX,
): string | null {
  if (body === undefined) return null;
  const flat = body.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return null;
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  // Break at the last space that fits unless that would eat more than half
  // the title (one giant word, a URL); then a mid-word clip reads better.
  return (sp > max / 2 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

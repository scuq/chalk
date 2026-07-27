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

// 49-2: fallback title for a head with no usable text but attachments.
//
// Image-ness is knowable WITHOUT decrypting anything: an attachment ref
// carries an inline encrypted preview for image kinds only, so the caller
// can pass allImages straight off the refs. The filename lives in the
// encrypted meta; when the caller has decrypted it (thread panel, local
// AES on a tiny blob), it upgrades the bare kind label to "image: cat.png".
// Multi-attachment heads keep a count label -- one filename would
// misrepresent the rest.
export function attachmentTitle(
  count: number,
  allImages: boolean,
  name?: string,
  max = THREAD_TITLE_MAX,
): string | null {
  if (count <= 0) return null;
  const kind = allImages ? "image" : "file";
  if (count === 1) {
    return name ? threadTitle(`${kind}: ${name}`, max) : `[${kind}]`;
  }
  return `[${count} ${kind}s]`;
}

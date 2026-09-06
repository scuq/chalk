// chalk 112-3 -- one decrypt per picture, however many rows draw it.
//
// A channel's feed shows the same sender dozens of times, the roster shows
// them again, and the hover card again. Resolving the picture per component
// would mean a ref fetch and an AES decrypt per row -- so resolution happens
// once per attachment id, here, and every caller gets the same object URL.
//
// The cache is module-level rather than a context because its lifetime is the
// tab's, not any component's: switching channels and coming back must not
// re-decrypt, and neither must scrolling a row out of the feed and back. It is
// keyed by attachment id, so two members who somehow share a blob share the
// URL, and a changed picture is a new id and therefore a new entry.
//
// Failure is remembered too. A picture whose blob is gone (404) or whose key
// this device does not hold resolves to null, and that null is cached: without
// it, every render of a locked channel would fetch again.

import type { AttachmentController } from "../attachments/pipeline";
import { wireRefToRef } from "../attachments/pipeline";
import { fetchAttachmentRef } from "../attachments/transport";
import { asBytes } from "../crypto/bytes";

/** Resolved pictures, by attachment id. null means "tried, cannot". */
const urls = new Map<string, string | null>();
/** In-flight resolutions, so ten rows asking at once make one request. */
const inflight = new Map<string, Promise<string | null>>();
/** Everyone waiting for a repaint when a resolution lands. */
const listeners = new Set<() => void>();

/** subscribe registers a callback fired whenever a picture resolves, so
 *  components re-render exactly when there is something new to draw. */
export function subscribeAvatars(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce(): void {
  for (const fn of listeners) fn();
}

/** peekAvatar returns a resolved URL, null for known-unresolvable, or
 *  undefined when nothing has been tried yet. Synchronous: a render reads it
 *  and asks for a resolution only when it comes back undefined. */
export function peekAvatar(attachmentID: string): string | null | undefined {
  return urls.get(attachmentID);
}

/**
 * resolveAvatar fetches, decrypts and caches one picture. Concurrent callers
 * share the same promise; a resolved id is never fetched twice.
 */
export function resolveAvatar(
  controller: AttachmentController,
  channelID: string,
  attachmentID: string,
): Promise<string | null> {
  if (!attachmentID) return Promise.resolve(null);
  const known = urls.get(attachmentID);
  if (known !== undefined) return Promise.resolve(known);
  const pending = inflight.get(attachmentID);
  if (pending) return pending;

  const p = (async (): Promise<string | null> => {
    try {
      const wire = await fetchAttachmentRef(attachmentID);
      const ref = wireRefToRef(wire);
      const meta = await controller.decryptMeta(channelID, ref);
      if (!meta) return null; // key not held: no picture, no placeholder
      const bytes = await controller.loadFullBytes(channelID, ref);
      if (!bytes) return null;
      return URL.createObjectURL(new Blob([asBytes(bytes)], { type: meta.mime }));
    } catch {
      // Gone, offline, or never ours -- all the same answer.
      return null;
    }
  })();

  inflight.set(attachmentID, p);
  void p.then((url) => {
    urls.set(attachmentID, url);
    inflight.delete(attachmentID);
    announce();
  });
  return p;
}

/**
 * clearAvatarCache drops every resolved picture and revokes its URL. Called on
 * sign-out, where keeping decrypted faces in memory (and in the blob store)
 * would outlive the session that was allowed to see them.
 */
export function clearAvatarCache(): void {
  for (const url of urls.values()) {
    if (url) URL.revokeObjectURL(url);
  }
  urls.clear();
  inflight.clear();
  announce();
}

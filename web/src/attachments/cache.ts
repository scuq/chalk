// chalk att-2 -- attachment ciphertext cache (LRU, bounded by total bytes).
//
// Wraps the raw idb attachment_cache store with the policy the spec's S4-FINAL
// decision requires: cache the SERVER'S CIPHERTEXT (full blobs + previews) so
// scroll-back skips the network, bounded by a total-byte cap with least-
// recently-used eviction. Storing ciphertext (not decrypted images) keeps the
// "only key-protected bytes touch disk" invariant -- a profile attacker still
// needs the space-key store to read anything.
//
// Guardrails (S4-FINAL):
//   * bounded by CACHE_MAX_BYTES (default 256 MiB), LRU eviction past the cap;
//   * cleared on logout + via a settings "clear cached images" control
//     (clearAttachmentCache, called from App);
//   * cache key = attachment-id + key-version + variant (content-addressed; no
//     rotation invalidation needed -- already-fetched ciphertext stays valid).
//
// Object-URL lifecycle (decrypt -> blob URL -> revoke) lives in the renderer
// (AttachmentView); this module only persists/serves ciphertext.

import {
  type AttachmentCacheVariant,
  getAttachmentBlob,
  putAttachmentBlob,
  deleteAttachmentBlob,
  listAttachmentCacheMeta,
  clearAttachmentCache as clearStore,
} from "../crypto/idb";

/** Default cache cap: 256 MiB of ciphertext across all channels on this device. */
const DEFAULT_CACHE_MAX_BYTES = 256 * 1024 * 1024;

let cacheMaxBytes = DEFAULT_CACHE_MAX_BYTES;

/**
 * setCacheMaxBytes overrides the LRU cap (e.g. from a server-surfaced
 * CHALK_ATTACH_CACHE_MAX_BYTES value, or a settings control). Values < 1 are
 * ignored. Lowering the cap shrinks the cache on the next enforce.
 */
export function setCacheMaxBytes(bytes: number): void {
  if (bytes >= 1) cacheMaxBytes = bytes;
}

/** getCacheMaxBytes returns the current LRU cap in bytes. */
export function getCacheMaxBytes(): number {
  return cacheMaxBytes;
}

/** cacheGet returns cached ciphertext for a variant, or null on a miss. */
export async function cacheGet(
  attachmentID: string,
  keyVersion: number,
  variant: AttachmentCacheVariant,
): Promise<Uint8Array | null> {
  try {
    return await getAttachmentBlob(attachmentID, keyVersion, variant);
  } catch {
    return null; // a broken cache must never break the render; fall through to network
  }
}

/**
 * cachePut stores ciphertext for a variant and enforces the byte budget. A
 * single blob larger than the whole cap is not cached (it would evict
 * everything and still not fit); the caller still has it in memory for this
 * render. Cache failures are swallowed -- caching is an optimization, never a
 * correctness dependency.
 */
export async function cachePut(
  attachmentID: string,
  keyVersion: number,
  variant: AttachmentCacheVariant,
  bytes: Uint8Array,
): Promise<void> {
  if (bytes.byteLength > cacheMaxBytes) return;
  try {
    await putAttachmentBlob(attachmentID, keyVersion, variant, bytes);
    await enforceBudget();
  } catch {
    // ignore: best-effort cache
  }
}

/**
 * enforceBudget evicts least-recently-used entries until the total cached bytes
 * are within the cap. Exported for tests + the settings panel's size readout
 * path; normally invoked by cachePut.
 */
export async function enforceBudget(): Promise<void> {
  let entries;
  try {
    entries = await listAttachmentCacheMeta();
  } catch {
    return;
  }
  let total = 0;
  for (const e of entries) total += e.byteLen;
  if (total <= cacheMaxBytes) return;
  // Oldest first; evict until under the cap.
  entries.sort((a, b) => a.lastAccess - b.lastAccess);
  for (const e of entries) {
    if (total <= cacheMaxBytes) break;
    try {
      await deleteAttachmentBlob(e.cacheKey);
      total -= e.byteLen;
    } catch {
      // skip a stubborn entry; the next enforce retries
    }
  }
}

/** cacheTotalBytes reports the current cached size (for a settings readout). */
export async function cacheTotalBytes(): Promise<number> {
  try {
    const entries = await listAttachmentCacheMeta();
    return entries.reduce((sum, e) => sum + e.byteLen, 0);
  } catch {
    return 0;
  }
}

/** clearCache wipes all cached attachment ciphertext (logout / settings). */
export async function clearCache(): Promise<void> {
  try {
    await clearStore();
  } catch {
    // ignore
  }
}

// chalk 111-8 -- resolving a channel banner's picture.
//
// Two callers need the same bytes: the band in the channel header, and the
// editor's live preview. Both start from an attachment id and nothing else,
// because that is all the channel row holds, and both get there the same way:
//
//   1. GET /api/attachments/{id}/ref  -- key version + enc_meta. The windowed
//      list query cannot answer for a banner set months ago, and the blob is
//      linked to no message, so this endpoint (111-1) exists for exactly this.
//   2. controller.loadFullBytes       -- cache-first against the ciphertext in
//      IndexedDB, so returning to a channel repaints it with no network.
//
// Fail-closed and quiet: no key, a decrypt that returns null, a 404 from a
// blob that is no longer there -- the hook returns no URL and the caller draws
// nothing. A missing banner is never an error on screen.

import { useEffect, useRef, useState } from "preact/hooks";
import type { AttachmentController } from "./pipeline";
import { wireRefToRef } from "./pipeline";
import { fetchAttachmentRef } from "./transport";
import type { AttachmentRef } from "./types";
import { asBytes } from "../crypto/bytes";

export interface BannerImage {
  /** object URL of the decrypted picture, or null while (or if never) loading */
  url: string | null;
  /** the ref, for handing the picture to the lightbox */
  ref: AttachmentRef | null;
  /** the decrypted filename, for alt text */
  name: string;
}

export function useBannerImage(
  channelID: string,
  attachmentID: string,
  controller: AttachmentController | null,
): BannerImage {
  const [state, setState] = useState<BannerImage>({ url: null, ref: null, name: "" });
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    // A channel switch must not leave the previous room's picture on screen
    // for the moment the new one takes to arrive.
    setState({ url: null, ref: null, name: "" });
    if (!attachmentID || !controller) return;

    void (async () => {
      try {
        const wire = await fetchAttachmentRef(attachmentID);
        if (!alive) return;
        const ref = wireRefToRef(wire);
        const meta = await controller.decryptMeta(channelID, ref);
        if (!alive || !meta) return; // no key held: no picture, no placeholder
        const bytes = await controller.loadFullBytes(channelID, ref);
        if (!alive || !bytes) return;
        const url = URL.createObjectURL(new Blob([asBytes(bytes)], { type: meta.mime }));
        urlRef.current = url;
        setState({ url, ref, name: meta.name || "channel banner" });
      } catch {
        // 404 (cleared, purged, or never ours), offline, a decrypt that
        // failed: all the same answer -- no picture.
      }
    })();

    return () => {
      alive = false;
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current);
        urlRef.current = null;
      }
    };
  }, [channelID, attachmentID, controller]);

  return state;
}

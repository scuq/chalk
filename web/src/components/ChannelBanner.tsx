// chalk 111-3 -- the channel banner: a picture pinned under the channel title.
//
// The band lives inside the sticky header block, so it stays put while the
// feed scrolls -- "pinned to the title" is the whole point, and a banner that
// scrolls away is one nobody sees in a busy room. It is deliberately short
// (the CSS owns the height) and cropped rather than fitted: a wide screenshot
// and a square piece of box art both have to read as the same band.
//
// What it is handed is an attachment id and nothing else, because that is all
// the channel row holds. Resolving it takes two cache-friendly steps:
//
//   1. GET /api/attachments/{id}/ref  -- key version + enc_meta. The windowed
//      list query cannot answer for a banner set months ago, and the blob is
//      linked to no message, so this endpoint (111-1) exists for exactly this.
//   2. controller.loadFullBytes       -- cache-first against the ciphertext in
//      IndexedDB, so returning to a channel repaints it with no network.
//
// Fail-closed, and quietly: no key, a decrypt that returns null, a 404 from a
// blob that is no longer there -- the band renders nothing and the header is
// what it was before 111. A missing banner is never an error on screen.

import { useEffect, useRef, useState } from "preact/hooks";
import type { AttachmentController } from "../attachments/pipeline";
import { wireRefToRef } from "../attachments/pipeline";
import { fetchAttachmentRef } from "../attachments/transport";
import type { AttachmentRef } from "../attachments/types";
import { asBytes } from "../crypto/bytes";
import { Lightbox } from "./Lightbox";

interface Props {
  channelID: string;
  /** the channel row's banner_attachment_id; "" / absent renders nothing */
  attachmentID: string;
  controller: AttachmentController;
}

export function ChannelBanner({ channelID, attachmentID, controller }: Props) {
  const [ref, setRef] = useState<AttachmentRef | null>(null);
  const [url, setURL] = useState<string | null>(null);
  const [alt, setAlt] = useState("channel banner");
  const [expanded, setExpanded] = useState(false);
  const urlRef = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    // A channel switch must not leave the previous room's picture on screen
    // for the moment the new one takes to arrive.
    setRef(null);
    setURL(null);
    setExpanded(false);
    if (!attachmentID) return;

    void (async () => {
      try {
        const wire = await fetchAttachmentRef(attachmentID);
        if (!alive) return;
        const r = wireRefToRef(wire);
        setRef(r);
        const meta = await controller.decryptMeta(channelID, r);
        if (!alive || !meta) return; // no key held: no band, no placeholder
        const bytes = await controller.loadFullBytes(channelID, r);
        if (!alive || !bytes) return;
        const objectURL = URL.createObjectURL(
          new Blob([asBytes(bytes)], { type: meta.mime }),
        );
        urlRef.current = objectURL;
        setURL(objectURL);
        setAlt(meta.name || "channel banner");
      } catch {
        // 404 (cleared, purged, or never ours), offline, a decrypt that
        // failed: all the same answer -- show no band.
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

  if (!url) return null;

  return (
    <>
      <div class="chalk-channel-banner" data-testid="channel-banner">
        <img
          src={url}
          alt={alt}
          class="chalk-channel-banner-img"
          onClick={() => setExpanded(true)}
          title="open the full image"
        />
      </div>
      {/* The cropped band is a poor look at a picture. Clicking opens the
          whole thing in the gallery lightbox (110-1), which already knows
          how to zoom and how to close. A banner is a set of one, so its
          arrows and counter hide themselves. */}
      {expanded && ref && (
        <Lightbox
          channelID={channelID}
          images={[ref]}
          index={0}
          controller={controller}
          onIndex={() => {}}
          onClose={() => setExpanded(false)}
        />
      )}
    </>
  );
}

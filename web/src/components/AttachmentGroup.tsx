// chalk 101-1 -- one message's attachments as a block.
//
// Two or more images tile into a WhatsApp-style grid (two columns of square
// crops, an odd count widening the first tile, anything past TILE_CAP behind
// a "+N" overlay that expands the grid in place). A lone image and every
// file kind keep the flat att-2 rows. Images are told apart from files by
// the ref's inline preview (tiles.ts) -- no decryption at this level; each
// tile is still a full AttachmentView, so decrypt, fail-closed lock state
// and the lightbox all work per-image exactly as before.

import { useState } from "preact/hooks";
import type { AttachmentController } from "../attachments/pipeline";
import type { AttachmentRef } from "../attachments/types";
import { isImageRef, tileLayout } from "../attachments/tiles";
import { AttachmentView } from "./AttachmentView";

interface Props {
  channelID: string;
  attachments: AttachmentRef[];
  controller: AttachmentController;
}

export function AttachmentGroup({ channelID, attachments, controller }: Props) {
  const [showAll, setShowAll] = useState(false);
  const images = attachments.filter(isImageRef);

  if (images.length < 2) {
    return (
      <>
        {attachments.map((att) => (
          <AttachmentView key={att.id} channelID={channelID} att={att} controller={controller} />
        ))}
      </>
    );
  }

  const files = attachments.filter((att) => !isImageRef(att));
  const layout = tileLayout(images.length, showAll);
  const visible = images.slice(0, layout.visible);
  return (
    <>
      <div
        class={`chalk-attachment-grid${layout.wideFirst ? " chalk-attachment-grid--widefirst" : ""}`}
        data-testid="attachment-grid"
      >
        {visible.map((att, i) => (
          <div class="chalk-attachment-tile" key={att.id}>
            <AttachmentView channelID={channelID} att={att} controller={controller} tile />
            {layout.hidden > 0 && i === visible.length - 1 && (
              <button
                type="button"
                class="chalk-attachment-tile-more"
                onClick={() => setShowAll(true)}
                aria-label={`show ${layout.hidden} more image${layout.hidden === 1 ? "" : "s"}`}
                data-testid="attachment-tile-more"
              >
                +{layout.hidden}
              </button>
            )}
          </div>
        ))}
      </div>
      {files.map((att) => (
        <AttachmentView key={att.id} channelID={channelID} att={att} controller={controller} />
      ))}
    </>
  );
}

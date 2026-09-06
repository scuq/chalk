// chalk 111-3 -- the channel banner: a picture pinned under the channel title.
//
// The band lives inside the sticky header block, so it stays put while the
// feed scrolls -- "pinned to the title" is the whole point, and a banner that
// scrolls away is one nobody sees in a busy room.
//
// This component is now only the wiring: useBannerImage turns the channel
// row's attachment id into decrypted bytes (111-8), BannerBand draws them the
// way the layout says, and clicking opens the gallery lightbox. Everything
// about how the picture is framed lives in the layout its owner saved through
// the editor (111-9).
//
// Fail-closed, and quietly: no key, a decrypt that returns null, a 404 from a
// blob that is no longer there -- the hook returns no URL, this renders
// nothing, and the header is what it was before 111.

import { useState } from "preact/hooks";
import type { AttachmentController } from "../attachments/pipeline";
import { useBannerImage } from "../attachments/use-banner-image";
import type { BannerLayout } from "../state/banner";
import { BannerBand } from "./BannerBand";
import { Lightbox } from "./Lightbox";

interface Props {
  channelID: string;
  layout: BannerLayout;
  controller: AttachmentController;
}

export function ChannelBanner({ channelID, layout, controller }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { url, ref, name } = useBannerImage(channelID, layout.attachmentID, controller);

  if (!url) return null;

  return (
    <>
      <BannerBand url={url} layout={layout} alt={name} onClick={() => setExpanded(true)} />
      {/* A band is a poor look at a picture, cropped or shrunk. Clicking
          opens the whole thing in the gallery lightbox (110-1), which
          already knows how to zoom and how to close. A banner is a set of
          one, so its arrows and counter hide themselves. */}
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

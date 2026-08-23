// chalk 101-1 -- layout math for the multi-image tile grid.
//
// An attachment's kind is sealed inside enc_meta, so the feed cannot ask
// "is this an image?" without decrypting. But the inline encrypted preview
// travels on the ref itself and is minted for image kinds only (spec S3), so
// its presence is a server-opaque, decrypt-free image signal. That is what
// lets the grid partition images from files synchronously at render time.

import type { AttachmentRef } from "./types";

/** Collapsed grid shows at most this many tiles; the rest sit behind "+N". */
export const TILE_CAP = 4;

/** True when the ref carries an inline preview, i.e. was sent as an image. */
export function isImageRef(att: AttachmentRef): boolean {
  return att.previewLen > 0 || !!att.encPreviewB64;
}

export interface TileLayout {
  /** how many image tiles render */
  visible: number;
  /** images behind the "+N" overlay on the last tile (0 when expanded) */
  hidden: number;
  /** odd visible count: the first tile spans both columns (2:1) */
  wideFirst: boolean;
}

/**
 * tileLayout sizes the grid for a message with `imageCount` images (callers
 * only tile at 2+; below that the flat single-image layout applies). The grid
 * is two columns of square tiles; an odd count widens the FIRST tile across
 * both columns so no row is left ragged -- 3 reads as big-plus-pair, 5 as
 * big-plus-2x2. Collapsed, at most TILE_CAP tiles show and the remainder is
 * reported as `hidden` for the "+N" overlay.
 */
export function tileLayout(imageCount: number, showAll: boolean): TileLayout {
  const visible = showAll ? imageCount : Math.min(imageCount, TILE_CAP);
  return {
    visible,
    hidden: imageCount - visible,
    wideFirst: visible % 2 === 1,
  };
}

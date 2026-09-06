// chalk 112-2 -- preparing a profile picture for upload.
//
// An avatar is drawn at one line of text -- around 14 CSS pixels -- in the
// feed, and at most a few dozen in a hover card or a call tile. So what goes
// up is 96x96: enough for a retina hover card, small enough that the
// per-channel fan-out is a handful of kilobytes rather than a handful of
// megabytes.
//
// Square, because the rendering is square everywhere and a non-square blob
// would only push the cropping decision onto every surface that draws one.
// Which square is the uploader's choice: the picture goes through the same
// cropper the banner uses (111-13), and whatever region comes back is scaled
// to fit. A region that is not square is centred and cover-cropped, so the
// result is always exactly 96x96 with nothing stretched.

import { type CropRect, FULL_CROP, cropToPixels } from "./crop";

/** Stored size, in pixels. Square. */
export const AVATAR_PX = 96;

/** Raw file cap, checked before anything is decoded. Generous: what leaves
 *  is 96x96 whatever came in. */
export const AVATAR_MAX_INPUT_BYTES = 20 * 1024 * 1024;

/** avatarRejectReason is the pre-decode gate: a message when the file cannot
 *  be a picture of anyone, null when it is worth trying. */
export function avatarRejectReason(type: string, size: number): string | null {
  if (!type.startsWith("image/")) return "that is not an image";
  if (size > AVATAR_MAX_INPUT_BYTES) return "image too large (20 MB max)";
  return null;
}

/**
 * coverBox works out which part of a source rectangle to draw so that it
 * fills a square without stretching: the long side is trimmed evenly at both
 * ends, the short side is used whole. Pure, so the arithmetic is tested
 * without a canvas.
 */
export function coverBox(
  sw: number,
  sh: number,
): { sx: number; sy: number; size: number } {
  const size = Math.max(1, Math.min(sw, sh));
  return {
    sx: Math.round((sw - size) / 2),
    sy: Math.round((sh - size) / 2),
    size,
  };
}

/**
 * prepareAvatar turns a decoded image (and an optional chosen region) into
 * the square File that gets uploaded. Throws with something worth showing
 * when the browser will not give a canvas or a blob.
 */
export async function prepareAvatar(
  img: HTMLImageElement,
  rect: CropRect = FULL_CROP,
  name = "avatar.jpg",
): Promise<File> {
  const region = cropToPixels(rect, img.naturalWidth, img.naturalHeight);
  const box = coverBox(region.sw, region.sh);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_PX;
  canvas.height = AVATAR_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not read that image");
  ctx.drawImage(
    img,
    region.sx + box.sx,
    region.sy + box.sy,
    box.size,
    box.size,
    0,
    0,
    AVATAR_PX,
    AVATAR_PX,
  );
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.85),
  );
  if (!blob) throw new Error("could not read that image");
  return new File([blob], name, { type: "image/jpeg" });
}

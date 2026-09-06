// chalk 111-13 -- cropping a banner before it is pinned.
//
// Everything else in the editor frames the picture: fit, focus and zoom pick
// which part of it the band shows, and none of them change the picture. A crop
// does -- it decides what the picture IS, and the parts outside it are gone.
// That is the difference the editor draws too: you crop first, then frame what
// is left.
//
// The crop is destructive on purpose. A rectangle stored beside the layout
// would be re-editable forever, at the cost of four more columns and a render
// that has to compose crop x fit x zoom x focus in CSS for three shapes. What
// actually goes up instead is the cropped picture: a canvas draw of the chosen
// region, re-encoded and uploaded like any other banner. The rendering never
// learns a thing, every member downloads only the part that is kept, and the
// editor holds the pre-crop image for as long as it is open, so "revert" is a
// button rather than an impossibility.
//
// Rectangles are percentages of the source image, not pixels: the cropper
// draws the image at whatever size the dialog allows, and a fraction survives
// that where a pixel count would not.

/** A crop rectangle in percent of the source image. */
export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The whole picture -- what "no crop" means. */
export const FULL_CROP: CropRect = { x: 0, y: 0, w: 100, h: 100 };

/** Smallest crop, in percent. Small enough for a detail, large enough that a
 *  stray click cannot leave a picture nobody can see. */
export const MIN_CROP = 5;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** round keeps stored rectangles whole-percent, so a rectangle that survives
 *  a round trip through the editor is the one that was drawn. */
const round = (r: CropRect): CropRect => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  w: Math.round(r.w),
  h: Math.round(r.h),
});

/**
 * rectFromCorners builds a rectangle from a drag: two points in either order,
 * each in percent, clamped into the picture and never smaller than MIN_CROP.
 * A drag that ends where it started is a rectangle of the minimum size rather
 * than nothing, so a click never produces an empty crop.
 */
export function rectFromCorners(
  ax: number,
  ay: number,
  bx: number,
  by: number,
): CropRect {
  const x1 = clamp(Math.min(ax, bx), 0, 100);
  const y1 = clamp(Math.min(ay, by), 0, 100);
  const x2 = clamp(Math.max(ax, bx), 0, 100);
  const y2 = clamp(Math.max(ay, by), 0, 100);
  let w = Math.max(x2 - x1, MIN_CROP);
  let h = Math.max(y2 - y1, MIN_CROP);
  // Growing to the minimum must not push the rectangle off the picture.
  const x = Math.min(x1, 100 - w);
  const y = Math.min(y1, 100 - h);
  w = Math.min(w, 100 - x);
  h = Math.min(h, 100 - y);
  return round({ x, y, w, h });
}

/**
 * moveRect slides a rectangle by a delta in percent, stopping at the edges of
 * the picture rather than shrinking or leaving it. Dragging a crop off the
 * side should feel like it hits a wall, not like it deforms.
 */
export function moveRect(r: CropRect, dx: number, dy: number): CropRect {
  return round({
    x: clamp(r.x + dx, 0, 100 - r.w),
    y: clamp(r.y + dy, 0, 100 - r.h),
    w: r.w,
    h: r.h,
  });
}

export type CropCorner = "nw" | "ne" | "sw" | "se";

/**
 * resizeRect drags one corner to (px, py), keeping the opposite corner fixed.
 * Dragging a corner past its opposite flips the rectangle rather than
 * inverting it -- rectFromCorners does the ordering, so a crop is always a
 * positive area.
 */
export function resizeRect(r: CropRect, corner: CropCorner, px: number, py: number): CropRect {
  const left = r.x;
  const top = r.y;
  const right = r.x + r.w;
  const bottom = r.y + r.h;
  switch (corner) {
    case "nw":
      return rectFromCorners(px, py, right, bottom);
    case "ne":
      return rectFromCorners(left, py, px, bottom);
    case "sw":
      return rectFromCorners(px, top, right, py);
    case "se":
      return rectFromCorners(left, top, px, py);
  }
}

/** isFullCrop says whether a rectangle would remove anything at all. Used to
 *  keep "apply" from re-encoding a picture into an identical one. */
export function isFullCrop(r: CropRect): boolean {
  return r.x <= 0 && r.y <= 0 && r.w >= 100 && r.h >= 100;
}

/** cropToPixels turns a percentage rectangle into the source rectangle a
 *  canvas drawImage takes, never zero-sized and never past the edge. */
export function cropToPixels(
  r: CropRect,
  width: number,
  height: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const sx = clamp(Math.round((r.x / 100) * width), 0, Math.max(0, width - 1));
  const sy = clamp(Math.round((r.y / 100) * height), 0, Math.max(0, height - 1));
  const sw = clamp(Math.round((r.w / 100) * width), 1, width - sx);
  const sh = clamp(Math.round((r.h / 100) * height), 1, height - sy);
  return { sx, sy, sw, sh };
}

/**
 * cropImage draws the chosen region of an already-decoded image into a new
 * canvas and hands back a PNG File. PNG rather than JPEG because the upload
 * pipeline re-encodes anyway (prepareBanner downscales to a JPEG), and a
 * lossy step here would be a second generation of loss for nothing.
 *
 * Throws when the browser will not give a 2D context or a blob, so the caller
 * can say so rather than silently pinning the uncropped picture.
 */
export async function cropImage(
  img: HTMLImageElement,
  rect: CropRect,
  name = "banner.png",
): Promise<File> {
  const { sx, sy, sw, sh } = cropToPixels(rect, img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("could not crop that image");
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("could not crop that image");
  return new File([blob], name, { type: "image/png" });
}

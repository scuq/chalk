// chalk 111-2 -- preparing a channel banner for upload.
//
// A banner is an ordinary attachment (encrypted under the channel key,
// chunk-uploaded, never linked to a message), so nothing here touches crypto
// or transport. What it does is bound what goes up: the band renders the image
// at 88 CSS pixels tall, cropped to the pane's width, so a 12 MB phone photo
// would cost every member of the channel a 12 MB download to paint a strip.
//
// The downscale reuses makePreview -- the same canvas path the feed's
// thumbnails take, at a much larger edge. 1600px is chosen against the widest
// the band can be (a full-window layout on a large display, doubled for
// retina); above that the extra pixels never reach a screen.

import { makePreview } from "./preview";

/** Longest edge of an uploaded banner, in pixels. */
export const BANNER_MAX_EDGE = 1600;

/** Raw file cap, checked before we try to decode anything. Mirrors the
 *  server's default CHALK_ATTACH_MAX_BYTES; the downscale means the blob that
 *  actually goes up is far smaller. */
export const BANNER_MAX_INPUT_BYTES = 20 * 1024 * 1024;

/**
 * bannerRejectReason is the pre-decode gate: a message when the file cannot be
 * a banner, null when it is worth trying. Kept apart from prepareBanner so it
 * is testable without a canvas.
 */
export function bannerRejectReason(type: string, size: number): string | null {
  if (!type.startsWith("image/")) return "that is not an image";
  if (size > BANNER_MAX_INPUT_BYTES) return "image too large (20 MB max)";
  return null;
}

/**
 * prepareBanner downscales an image File to the banner's bounds and hands back
 * a File the upload pipeline can take as-is. Throws with a message meant for
 * the menu when the file is not usable -- the caller shows it beside the
 * button rather than failing silently.
 */
export async function prepareBanner(file: File): Promise<File> {
  const reason = bannerRejectReason(file.type, file.size);
  if (reason) throw new Error(reason);
  const scaled = await makePreview(file, BANNER_MAX_EDGE);
  if (!scaled) throw new Error("could not read that image");
  // The name only lives inside enc_meta, but it is what a download would be
  // called, so keep it recognizable.
  const base = file.name.replace(/\.[^.]+$/, "") || "banner";
  return new File([scaled.bytes as BlobPart], `${base}.jpg`, { type: scaled.mime });
}

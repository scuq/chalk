// chalk 111-7 -- the channel banner's layout, client side.
//
// The server stores these and never reads them; every decision they encode is
// the renderer's. That cuts both ways: the client must not trust what comes
// back either. A summary is written by whoever owns the channel and stored by
// a server chalk does not trust with presentation, so every value is
// normalized on the way in -- an out-of-range zoom or an unknown bleed name
// becomes the default rather than a broken header.

/** How the picture meets the band. "poster" (111-12) puts it at band height
 *  at one end and gives the rest to the bleed -- box art on a backdrop, for
 *  the tall pictures that neither of the other two can flatter. */
export type BannerFit = "fill" | "fit" | "poster";
/** How tall the band is. Names, not pixels: the CSS decides what they mean,
 *  and it means something different on a phone. */
export type BannerHeight = "short" | "normal" | "tall";
/** What fills the space beside the picture. 111-11 replaced the old "edge"
 *  (the picture's own edge columns, stretched sideways) with the wash: the
 *  columns streaked on anything with a hard horizontal edge in it. */
export type BannerBleed = "wash" | "blur" | "none";

export interface BannerLayout {
  /** the attachment id of the picture; "" is not a valid layout */
  attachmentID: string;
  fit: BannerFit;
  /** 0-100, which part of the picture the band keeps when it crops */
  focusX: number;
  focusY: number;
  /** 100-300 percent */
  zoom: number;
  height: BannerHeight;
  bleed: BannerBleed;
}

export const ZOOM_MIN = 100;
export const ZOOM_MAX = 300;

/** The layout every channel had before there was an editor. */
export const DEFAULT_BANNER: Omit<BannerLayout, "attachmentID"> = {
  fit: "fill",
  focusX: 50,
  focusY: 50,
  zoom: 100,
  height: "normal",
  bleed: "wash",
};

const FITS: BannerFit[] = ["fill", "fit", "poster"];
const HEIGHTS: BannerHeight[] = ["short", "normal", "tall"];
const BLEEDS: BannerBleed[] = ["wash", "blur", "none"];

function clamp(n: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

/**
 * normalizeBanner turns whatever a summary carried into a layout that is safe
 * to render, or null when there is no picture. Unlike the server's fences,
 * which refuse a bad value so the client learns about its bug, this one
 * repairs: by the time a summary reaches a renderer the write is long done,
 * and a header that will not draw helps nobody.
 */
export function normalizeBanner(raw: unknown): BannerLayout | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.attachment_id === "string" ? o.attachment_id.trim() : "";
  if (!id) return null;
  const fit = FITS.includes(o.fit as BannerFit) ? (o.fit as BannerFit) : DEFAULT_BANNER.fit;
  const height = HEIGHTS.includes(o.height as BannerHeight)
    ? (o.height as BannerHeight)
    : DEFAULT_BANNER.height;
  // 111-11: a channel saved before the rename says "edge"; it meant the
  // thing the wash replaced, so read it as the wash rather than silently
  // resetting someone's choice to the default.
  const rawBleed = o.bleed === "edge" ? "wash" : o.bleed;
  const bleed = BLEEDS.includes(rawBleed as BannerBleed)
    ? (rawBleed as BannerBleed)
    : DEFAULT_BANNER.bleed;
  return {
    attachmentID: id,
    fit,
    focusX: clamp(o.focus_x, 0, 100, DEFAULT_BANNER.focusX),
    focusY: clamp(o.focus_y, 0, 100, DEFAULT_BANNER.focusY),
    zoom: clamp(o.zoom, ZOOM_MIN, ZOOM_MAX, DEFAULT_BANNER.zoom),
    height,
    bleed,
  };
}

/** sameBanner is the reducer's "did anything change" -- a layout is small
 *  and flat, so this is the whole comparison. */
export function sameBanner(a: BannerLayout | null, b: BannerLayout | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.attachmentID === b.attachmentID &&
    a.fit === b.fit &&
    a.focusX === b.focusX &&
    a.focusY === b.focusY &&
    a.zoom === b.zoom &&
    a.height === b.height &&
    a.bleed === b.bleed
  );
}

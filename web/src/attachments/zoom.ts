// chalk 110-2 -- zoom and pan for the lightbox, as arithmetic.
//
// The view is one transform on the <img>: translate(tx, ty) then scale(s),
// about the element's own centre, over a base layout box the browser has
// already fitted to the viewport (max-width/max-height, object-fit: contain).
// Working from that box rather than from the image's natural pixels is what
// makes "scale 1" mean "fitted" on every screen, so the floor is always the
// picture whole and there is no state in which zooming out strands the user
// looking at a corner.
//
// All of it is pure: the component measures the DOM once per gesture into a
// Frame and asks for numbers back. That is the only way this is testable at
// all -- pinch and wheel need real events, but the arithmetic they drive is
// where the bugs live (a zoom that drifts off the cursor, a pan that lets the
// picture escape the screen).

export interface View {
  scale: number;
  /** offset of the image centre from the viewport centre, px, pre-scale-free */
  tx: number;
  ty: number;
}

/** The measured geometry a gesture happens in. */
export interface Frame {
  /** viewport centre, which is also the image's centre at rest */
  cx: number;
  cy: number;
  /** viewport size */
  vw: number;
  vh: number;
  /** the image's laid-out size at scale 1 */
  iw: number;
  ih: number;
}

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 8;
/** Where a double-click/tap lands when zooming in. */
export const ZOOM_TOGGLE = 2.5;
/** Anything above this counts as zoomed: gestures pan instead of paging. */
const ZOOMED_EPSILON = 0.01;
/** Wheel: e**(-deltaY * k). ~1.16x per 100px notch, smooth on a trackpad. */
const WHEEL_STEP = 0.0015;

export const IDENTITY: View = { scale: 1, tx: 0, ty: 0 };

export function isZoomed(v: View): boolean {
  return v.scale > ZOOM_MIN + ZOOMED_EPSILON;
}

export function clampScale(scale: number): number {
  // A pinch whose opening span was zero divides to NaN; that must read as
  // "no zoom", not propagate into the transform and blank the image.
  if (Number.isNaN(scale)) return ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale));
}

/** Math.min/max preserve -0, and -0 is not deep-equal to 0. Normalise it. */
function nz(n: number): number {
  return n === 0 ? 0 : n;
}

/**
 * How far the image may be moved off centre before an edge would come inside
 * the viewport. An axis the scaled image doesn't overflow gets 0 -- it stays
 * centred rather than sliding around in the empty space.
 */
export function panBounds(scale: number, f: Frame): { x: number; y: number } {
  return {
    x: Math.max(0, (f.iw * scale - f.vw) / 2),
    y: Math.max(0, (f.ih * scale - f.vh) / 2),
  };
}

export function clampView(v: View, f: Frame): View {
  const scale = clampScale(v.scale);
  const b = panBounds(scale, f);
  return {
    scale,
    tx: nz(Math.min(b.x, Math.max(-b.x, v.tx))),
    ty: nz(Math.min(b.y, Math.max(-b.y, v.ty))),
  };
}

/**
 * Zoom to `scale` while the viewport point (px, py) stays over the same pixel
 * of the picture -- the wheel zooms toward the cursor and a pinch grows around
 * its own midpoint, instead of both yanking the subject away from the finger.
 */
export function zoomAt(v: View, f: Frame, scale: number, px: number, py: number): View {
  const s = clampScale(scale);
  // Where the anchor sits in the image's own unscaled coordinates.
  const u = (px - f.cx - v.tx) / v.scale;
  const w = (py - f.cy - v.ty) / v.scale;
  return clampView({ scale: s, tx: px - f.cx - u * s, ty: py - f.cy - w * s }, f);
}

export function panBy(v: View, f: Frame, dx: number, dy: number): View {
  return clampView({ scale: v.scale, tx: v.tx + dx, ty: v.ty + dy }, f);
}

/** A wheel notch as a multiplier. Scrolling up (negative deltaY) zooms in. */
export function wheelFactor(deltaY: number): number {
  return Math.exp(-deltaY * WHEEL_STEP);
}

/** Double-click/double-tap: all the way out, or in to ZOOM_TOGGLE. */
export function toggleScale(v: View): number {
  return isZoomed(v) ? ZOOM_MIN : ZOOM_TOGGLE;
}

/** Distance between two touch points, for pinch. */
export function pinchSpan(x0: number, y0: number, x1: number, y1: number): number {
  return Math.hypot(x1 - x0, y1 - y0);
}

// chalk 110-2 -- lightbox zoom/pan arithmetic.

import test from "node:test";
import assert from "node:assert/strict";
import {
  type Frame,
  IDENTITY,
  type View,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_TOGGLE,
  clampScale,
  clampView,
  isZoomed,
  panBounds,
  panBy,
  pinchSpan,
  toggleScale,
  wheelFactor,
  zoomAt,
} from "./zoom.ts";

// A 1000x800 viewport with a 600x400 image fitted in the middle of it.
const F: Frame = { cx: 500, cy: 400, vw: 1000, vh: 800, iw: 600, ih: 400 };

const near = (a: number, b: number, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) < eps, `${a} !~= ${b}`);

test("clampScale holds the floor at fit and the ceiling at ZOOM_MAX", () => {
  assert.equal(clampScale(0.1), ZOOM_MIN);
  assert.equal(clampScale(100), ZOOM_MAX);
  assert.equal(clampScale(3), 3);
  // A pinch that divides by a zero span must not poison the view.
  assert.equal(clampScale(Number.NaN), ZOOM_MIN);
  assert.equal(clampScale(Number.POSITIVE_INFINITY), ZOOM_MAX);
});

test("panBounds is zero on an axis the image doesn't overflow", () => {
  // At scale 1 a 600x400 image inside 1000x800 overflows neither axis.
  assert.deepEqual(panBounds(1, F), { x: 0, y: 0 });
  // At scale 2 it is 1200x800: it overflows x by 200, y by nothing.
  assert.deepEqual(panBounds(2, F), { x: 100, y: 0 });
  assert.deepEqual(panBounds(4, F), { x: 700, y: 400 });
});

test("clampView keeps the picture from escaping the viewport", () => {
  const v = clampView({ scale: 2, tx: 5000, ty: 5000 }, F);
  assert.deepEqual(v, { scale: 2, tx: 100, ty: 0 });
  const back = clampView({ scale: 2, tx: -5000, ty: -5000 }, F);
  assert.deepEqual(back, { scale: 2, tx: -100, ty: 0 });
});

test("clampView recentres when the scale drops back to fit", () => {
  assert.deepEqual(clampView({ scale: 1, tx: 90, ty: 40 }, F), IDENTITY);
});

test("zoomAt keeps the anchor pixel under the cursor", () => {
  // Zoom in on a point 120px right and 60px below centre.
  const px = 620;
  const py = 460;
  const v = zoomAt(IDENTITY, F, 3, px, py);
  assert.equal(v.scale, 3);
  // The image coordinate under (px,py) before and after must be the same.
  const before = { u: (px - F.cx - 0) / 1, w: (py - F.cy - 0) / 1 };
  const after = { u: (px - F.cx - v.tx) / v.scale, w: (py - F.cy - v.ty) / v.scale };
  near(after.u, before.u);
  // y is clamped here (a 400px-tall image at 3x is 1200 > 800, so it can move):
  near(after.w, before.w);
});

test("zoomAt from the centre leaves the picture centred", () => {
  const v = zoomAt(IDENTITY, F, 2, F.cx, F.cy);
  assert.deepEqual(v, { scale: 2, tx: 0, ty: 0 });
});

test("zoomAt back out to fit always lands centred, whatever it was anchored on", () => {
  const zoomed = zoomAt(IDENTITY, F, 4, 900, 700);
  assert.ok(zoomed.tx !== 0 || zoomed.ty !== 0);
  assert.deepEqual(zoomAt(zoomed, F, 1, 100, 100), IDENTITY);
});

test("zoomAt never lets an anchor near the edge tear the image off screen", () => {
  const v = zoomAt(IDENTITY, F, 2, 0, 0);
  const b = panBounds(v.scale, F);
  assert.ok(Math.abs(v.tx) <= b.x);
  assert.ok(Math.abs(v.ty) <= b.y);
});

test("panBy moves one-to-one until it hits the bound", () => {
  const v: View = { scale: 4, tx: 0, ty: 0 };
  assert.deepEqual(panBy(v, F, 50, -30), { scale: 4, tx: 50, ty: -30 });
  // Bounds at 4x are 700/400; a 5000px drag stops there.
  assert.deepEqual(panBy(v, F, 5000, 5000), { scale: 4, tx: 700, ty: 400 });
});

test("panBy at fit scale cannot move anything", () => {
  assert.deepEqual(panBy(IDENTITY, F, 200, 200), IDENTITY);
});

test("wheelFactor zooms in scrolling up and out scrolling down, and inverts", () => {
  assert.ok(wheelFactor(-100) > 1);
  assert.ok(wheelFactor(100) < 1);
  assert.equal(wheelFactor(0), 1);
  near(wheelFactor(-100) * wheelFactor(100), 1, 1e-12);
});

test("toggleScale round-trips fit and ZOOM_TOGGLE", () => {
  assert.equal(toggleScale(IDENTITY), ZOOM_TOGGLE);
  assert.equal(toggleScale({ scale: ZOOM_TOGGLE, tx: 0, ty: 0 }), ZOOM_MIN);
  // A hair above fit still counts as fitted, so a stray pinch of a few
  // thousandths doesn't invert what the next double-tap does.
  assert.equal(toggleScale({ scale: 1.005, tx: 0, ty: 0 }), ZOOM_TOGGLE);
});

test("isZoomed gates the gestures: fit pages, zoomed pans", () => {
  assert.equal(isZoomed(IDENTITY), false);
  assert.equal(isZoomed({ scale: 1.005, tx: 0, ty: 0 }), false);
  assert.equal(isZoomed({ scale: 1.5, tx: 0, ty: 0 }), true);
});

test("pinchSpan is the distance between the two fingers", () => {
  assert.equal(pinchSpan(0, 0, 3, 4), 5);
  assert.equal(pinchSpan(10, 10, 10, 10), 0);
});

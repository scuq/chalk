// 111-5/111-6: the edge sampling behind a fitted banner's bleed. The canvas
// draw needs a DOM and is exercised by the UI probe; the pixel reading is
// here.

import test from "node:test";
import assert from "node:assert/strict";
import { columnGradient, edgeColumnsFromPixels } from "./banner-edges";

// Builds a row-major RGBA buffer from a per-pixel function.
function pixels(w: number, h: number, f: (x: number, y: number) => number[]) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = f(x, y);
      const i = (y * w + x) * 4;
      out[i] = r; out[i + 1] = g; out[i + 2] = b; out[i + 3] = a;
    }
  }
  return out;
}

test("the two edges are read from the two edge columns, not the middle", () => {
  // Left column red, right column blue, everything between bright green --
  // the middle must not reach the answer.
  const w = 5, h = 3;
  const buf = pixels(w, h, (x) =>
    x === 0 ? [200, 0, 0, 255] : x === w - 1 ? [0, 0, 200, 255] : [0, 255, 0, 255],
  );
  const got = edgeColumnsFromPixels(buf, w, h);
  assert.deepEqual(got, {
    left: ["rgb(200, 0, 0)", "rgb(200, 0, 0)", "rgb(200, 0, 0)"],
    right: ["rgb(0, 0, 200)", "rgb(0, 0, 200)", "rgb(0, 0, 200)"],
  });
});

// 111-6 is this test: one colour per side is exactly what left a seam.
test("a column keeps its rows apart instead of averaging them", () => {
  const w = 2, h = 2;
  // Top row black, bottom row white -- a horizon. Averaging would answer
  // mid-grey for both rows and the join with the picture would be a line.
  const buf = pixels(w, h, (_x, y) => (y === 0 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
  const got = edgeColumnsFromPixels(buf, w, h);
  assert.deepEqual(got?.left, ["rgb(0, 0, 0)", "rgb(255, 255, 255)"]);
  assert.deepEqual(got?.right, ["rgb(0, 0, 0)", "rgb(255, 255, 255)"]);
});

test("a transparent row takes its neighbour's colour, not black", () => {
  const w = 3, h = 3;
  // Left column: red, transparent, red. The hole must come back red.
  const buf = pixels(w, h, (x, y) => {
    if (x === 0) return y === 1 ? [0, 0, 0, 0] : [255, 0, 0, 255];
    return [10, 10, 10, 255];
  });
  const got = edgeColumnsFromPixels(buf, w, h);
  assert.deepEqual(got?.left, ["rgb(255, 0, 0)", "rgb(255, 0, 0)", "rgb(255, 0, 0)"]);
});

test("a transparent top is filled from below, and a transparent bottom from above", () => {
  const w = 2, h = 4;
  // Left column: transparent, transparent, green, transparent.
  const buf = pixels(w, h, (x, y) => {
    if (x === 0) return y === 2 ? [0, 200, 0, 255] : [0, 0, 0, 0];
    return [0, 200, 0, 255];
  });
  const got = edgeColumnsFromPixels(buf, w, h);
  assert.deepEqual(got?.left, Array(4).fill("rgb(0, 200, 0)"));
});

test("a fully transparent edge has no colour to bleed", () => {
  const buf = pixels(2, 2, () => [0, 0, 0, 0]);
  assert.equal(edgeColumnsFromPixels(buf, 2, 2), null);
});

test("a buffer smaller than it claims is refused rather than read past", () => {
  assert.equal(edgeColumnsFromPixels(new Uint8ClampedArray(4), 10, 10), null);
  assert.equal(edgeColumnsFromPixels(new Uint8ClampedArray(0), 0, 0), null);
});

test("the gradient carries every row, in order, top first", () => {
  const g = columnGradient(["rgb(1, 1, 1)", "rgb(2, 2, 2)", "rgb(3, 3, 3)"]);
  assert.equal(g, "linear-gradient(to bottom, rgb(1, 1, 1), rgb(2, 2, 2), rgb(3, 3, 3))");
  // Evenly spaced stops are the browser's default; no positions are written,
  // so the same column renders correctly at any band height.
  assert.ok(!g.includes("%"));
});

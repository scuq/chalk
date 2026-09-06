// chalk 111-5 -- what a fitted banner bleeds into its sides.
//
// In "fit" mode the whole picture is shown at band height, so it rarely spans
// the pane and the sides have to be filled with something. Filling them with
// the theme background alone leaves the image sitting in a box.
//
// 111-6: the fill is the image's own edge COLUMN, not one averaged colour.
// One colour per side left a hard vertical seam wherever the picture's edge
// was not flat -- a red sky over a black ridge met a single muddy red and the
// join was a line you could point at. A column, stretched sideways and faded
// out, meets the picture row for row: sky continues into sky, ridge into
// ridge, and there is no join to see.
//
// The column becomes a CSS `linear-gradient(to bottom, ...)` of one stop per
// sampled row, which the browser interpolates back to band height -- so the
// bleed is smooth vertically without any per-pixel work, and no canvas has to
// stay alive after the sample. The horizontal fade to the theme background is
// a mask over that gradient (the component's CSS).
//
// The sampling itself is pure and lives here (tested); the canvas draw is the
// caller's, because it needs a DOM.
//
// A small sample is the point, not a compromise: the browser's downscale is a
// box filter, so one column of a 24-wide draw already IS the average of that
// vertical slice of the original -- noise, JPEG ringing and a stray bright
// pixel all disappear into it.

/** Sample grid the caller draws into. 24 wide so an edge column is an edge
 *  and not a twelfth of the picture; 24 tall so the vertical gradient has
 *  enough stops to follow a horizon or a title bar. */
export const EDGE_SAMPLE_W = 24;
export const EDGE_SAMPLE_H = 24;

export interface EdgeColumns {
  /** the image's left edge, top row first; CSS rgb() strings */
  left: string[];
  /** the image's right edge, top row first */
  right: string[];
}

function css(r: number, g: number, b: number): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

/**
 * edgeColumnsFromPixels reads the first and last columns of an RGBA buffer
 * laid out row-major (canvas getImageData order) and returns one colour per
 * row. Returns null for a buffer that is not the size it claims, so a caller
 * never paints from garbage.
 *
 * Alpha is respected rather than ignored: a fully transparent row takes the
 * nearest opaque row's colour instead of black, so a logo on transparency
 * bleeds its own colour and not a dark smear into a light theme. A column
 * with no opaque pixel at all has no colour to speak of, and the answer is
 * null -- the sides then stay plain theme background, which is the same as
 * no bleed.
 */
export function edgeColumnsFromPixels(
  data: Uint8ClampedArray | number[],
  width: number,
  height: number,
): EdgeColumns | null {
  if (width <= 0 || height <= 0) return null;
  if (data.length < width * height * 4) return null;

  // Per row: the pixel's own colour when it is opaque enough to have one,
  // null when it is not. The gaps are filled from their neighbours below.
  const readColumn = (x: number): (string | null)[] => {
    const out: (string | null)[] = [];
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      const a = data[i + 3] / 255;
      out.push(a > 0 ? css(data[i], data[i + 1], data[i + 2]) : null);
    }
    return out;
  };

  // A transparent row copies the closest row that has a colour. Two passes,
  // down then up, so a gap anywhere -- top, bottom, middle -- is covered.
  const fill = (col: (string | null)[]): string[] | null => {
    let last: string | null = null;
    for (let y = 0; y < col.length; y++) {
      if (col[y] !== null) last = col[y];
      else if (last !== null) col[y] = last;
    }
    last = null;
    for (let y = col.length - 1; y >= 0; y--) {
      if (col[y] !== null) last = col[y];
      else if (last !== null) col[y] = last;
    }
    return col.every((c) => c !== null) ? (col as string[]) : null;
  };

  const left = fill(readColumn(0));
  const right = fill(readColumn(width - 1));
  if (!left || !right) return null;
  return { left, right };
}

/**
 * sampleEdgeColumns draws an already-decoded image into a small canvas and
 * reads its edge columns. Returns null whenever the browser will not play
 * along -- no 2D context, a tainted canvas, a decode that never happened --
 * and the caller falls back to a plain theme-coloured surround.
 */
export function sampleEdgeColumns(img: CanvasImageSource): EdgeColumns | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = EDGE_SAMPLE_W;
    canvas.height = EDGE_SAMPLE_H;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, EDGE_SAMPLE_W, EDGE_SAMPLE_H);
    const { data } = ctx.getImageData(0, 0, EDGE_SAMPLE_W, EDGE_SAMPLE_H);
    return edgeColumnsFromPixels(data, EDGE_SAMPLE_W, EDGE_SAMPLE_H);
  } catch {
    return null;
  }
}

/**
 * columnGradient turns one sampled column into the CSS that paints it: a
 * top-to-bottom gradient with the rows as evenly spaced stops. The browser's
 * interpolation between them is what makes a 24-row sample look continuous at
 * band height.
 */
export function columnGradient(column: string[]): string {
  return `linear-gradient(to bottom, ${column.join(", ")})`;
}

// ---- 111-11: the colour wash -----------------------------------------
//
// The edge-column bleed (above) continues a picture perfectly when its edges
// are smooth, and paints horizontal bands when they are not: a poster with a
// hard horizon in it has a black ridge on one row and a red sky on the next,
// and stretching those rows sideways is exactly as stripey as it sounds.
//
// So the default bleed became a wash instead: two colours taken from the
// whole picture, not its edges, painted as an even gradient. It cannot streak
// -- there is no structure in it to streak -- and it reads as a surface the
// picture is sitting on rather than a smeared copy of it.
//
// The quantiser is deliberately crude: 5 bits of colour per channel (32
// levels, 32768 buckets) over a 32x32 sample. Anything finer would separate
// shades nobody can tell apart and hand back two colours that make a gradient
// with no visible movement in it.

/** Sample grid for the wash. Bigger than the edge sample: this one is about
 *  the whole picture, so it needs enough pixels for a minority colour to
 *  survive. 32x32 is 1024 of them, which is plenty and still instant. */
export const WASH_SAMPLE = 32;

/** How far apart two colours must be (RGB distance) to count as different
 *  enough to be worth putting at opposite ends of a gradient. */
const MIN_SEPARATION = 60;

interface Bucket {
  r: number;
  g: number;
  b: number;
  weight: number;
}

/**
 * washColorsFromPixels returns the two colours to build the wash from: the
 * picture's most common colour first, then the most common colour far enough
 * from it to be visibly different. A picture with only one colour in it gets
 * that colour twice, which paints a flat wash -- correct, and better than
 * inventing contrast that is not in the image.
 *
 * Alpha below half is skipped rather than weighted: unlike the edge bleed,
 * this is about what the picture IS, and a mostly transparent pixel is not
 * part of that.
 */
export function washColorsFromPixels(
  data: Uint8ClampedArray | number[],
  width: number,
  height: number,
): [string, string] | null {
  if (width <= 0 || height <= 0) return null;
  if (data.length < width * height * 4) return null;

  const buckets = new Map<number, Bucket>();
  for (let i = 0; i < width * height * 4; i += 4) {
    if (data[i + 3] < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    const cur = buckets.get(key);
    if (cur) {
      cur.r += r;
      cur.g += g;
      cur.b += b;
      cur.weight++;
    } else {
      buckets.set(key, { r, g, b, weight: 1 });
    }
  }
  if (buckets.size === 0) return null;

  const ranked = [...buckets.values()].sort((a, b) => b.weight - a.weight);
  const mean = (x: Bucket) => [x.r / x.weight, x.g / x.weight, x.b / x.weight] as const;
  const first = mean(ranked[0]);
  let second = first;
  for (const cand of ranked.slice(1)) {
    const c = mean(cand);
    const d = Math.hypot(c[0] - first[0], c[1] - first[1], c[2] - first[2]);
    if (d >= MIN_SEPARATION) {
      second = c;
      break;
    }
  }
  const css = (c: readonly [number, number, number]) =>
    `rgb(${Math.round(c[0])}, ${Math.round(c[1])}, ${Math.round(c[2])})`;
  return [css(first), css(second)];
}

/**
 * sampleWashColors draws an already-decoded image into a small canvas and
 * reads its two wash colours. Null whenever the browser will not play along,
 * exactly like sampleEdgeColumns -- the caller then paints plain theme
 * background.
 */
export function sampleWashColors(img: CanvasImageSource): [string, string] | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = WASH_SAMPLE;
    canvas.height = WASH_SAMPLE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, WASH_SAMPLE, WASH_SAMPLE);
    const { data } = ctx.getImageData(0, 0, WASH_SAMPLE, WASH_SAMPLE);
    return washColorsFromPixels(data, WASH_SAMPLE, WASH_SAMPLE);
  } catch {
    return null;
  }
}

/**
 * washGradient paints one side of the band: the picture's dominant colour
 * where it meets the picture, the second colour at the far end. `toward` is
 * the direction away from the picture, so both sides mirror each other and
 * the band reads as one surface rather than two panels.
 */
export function washGradient(colors: [string, string], toward: "left" | "right"): string {
  return `linear-gradient(to ${toward}, ${colors[0]}, ${colors[1]})`;
}

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

// chalk-web -- 129-19: the parts that every scripted scene shares.
//
// A scripted scene paints an opaque strip of STRIP_H scene pixels with one
// draw function of the time. offseason.ts, christmas.ts, newyear.ts,
// winterfest.ts, blackweek.ts, and lateautumn.ts hold the scripts.
// This module holds the types of a script and the helpers that the scripts
// share: a hash, the CHALK sign, the stars, and a filled circle.
// Pure: nothing here uses a timer, a DOM, or a random source.

/** STRIP_H is the height in scene pixels that every script draws for. */
export const STRIP_H = 24;

/** Px paints one rectangle of scene pixels in a color. */
export type Px = (x: number, y: number, w: number, h: number, color: string) => void;

/** Alpha sets the opacity of the rectangles that follow, from 0 to 1. */
export type Alpha = (v: number) => void;

/**
 * A Script is one scripted scene. name is the name of the scene. period is
 * the length of its loop in seconds. still is the time in seconds of the frame
 * that shows when the system asks for reduced motion. draw paints the frame at
 * time t, in seconds since the scene started, on a strip W scene pixels wide.
 * draw paints the whole strip, so a script is opaque.
 */
export interface Script {
  name: string;
  period: number;
  still: number;
  // 129-22: the weight of the scene. A visit picks it in proportion to this
  // number, against the weights of the other scenes of its key. Absent means 1.
  weight?: number;
  draw(p: Px, a: Alpha, W: number, t: number): void;
}

// Returns a hash of n, as a number from 0 up to, but not including, 1.
export function rnd(n: number): number {
  const v = Math.sin(n * 127.1 + 78.233) * 43758.5453;
  return v - Math.floor(v);
}

// The font of the CHALK sign: five rows of three pixels for each letter.
const SIGN_FONT: Record<string, string[]> = {
  C: ["111", "100", "100", "100", "111"],
  H: ["101", "101", "111", "101", "101"],
  A: ["010", "101", "111", "101", "101"],
  L: ["100", "100", "100", "100", "111"],
  K: ["101", "110", "100", "110", "101"],
};

// Draws the CHALK sign, centered at the top of the strip, in rows 1 to 9. The
// colors are the plate, the edge, and the letters.
export function sign(p: Px, W: number, plate: string, edge: string, ink: string): void {
  const w = 5 * 4 - 1 + 4;
  const x0 = Math.round(W / 2 - w / 2);
  p(x0, 1, w, 9, edge);
  p(x0 + 1, 2, w - 2, 7, plate);
  [..."CHALK"].forEach((ch, i) => {
    SIGN_FONT[ch].forEach((row, ry) =>
      [...row].forEach((b, rx) => {
        if (b === "1") p(x0 + 2 + i * 4 + rx, 3 + ry, 1, 1, ink);
      }),
    );
  });
}

// Draws n stars in the rows above maxY. A star twinkles from the time t.
export function stars(p: Px, W: number, seed: number, n: number, maxY: number, t: number): void {
  for (let i = 0; i < n; i++) {
    const x = Math.floor(rnd(i * 3.1 + seed) * W);
    const y = Math.floor(rnd(i * 7.7 + seed) * maxY);
    p(x, y, 1, 1, Math.sin(t * 2 + i * 1.7) > 0.7 ? "#ffffff" : "#6f7da0");
  }
}

// Draws a filled circle of radius r at cx, cy. It leaves out the rows from
// clipY down.
export function disc(p: Px, cx: number, cy: number, r: number, color: string, clipY = STRIP_H): void {
  for (let y = Math.floor(cy - r); y <= cy + r; y++) {
    if (y < 0 || y >= clipY) continue;
    const dx = Math.sqrt(Math.max(0, r * r - (y - cy) * (y - cy)));
    p(Math.round(cx - dx), y, Math.max(1, Math.round(dx * 2)), 1, color);
  }
}

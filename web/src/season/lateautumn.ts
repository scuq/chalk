// chalk-web -- 129-23: the late-autumn scenes. 129-25: eight scenes.
//
// On 16 to 22 November, the "late-autumn" key shows one of these eight scenes.
// Each scene is a nod to a film or a series, and a person knows it by one
// moment in autumn. No scene nods to a game. A scene has no title, no logo, no
// lettering, and no likeness of an actor. A character is generic. The only text
// is the CHALK sign. A scene is a Script (strip.ts). scene.ts runs these
// scripts in place of rows for the "late-autumn" key.

import { disc, rnd, sign, stars, STRIP_H, type Alpha, type Px, type Script } from "./strip";

const H = STRIP_H;

// The colors of the falling leaves and of the leaves on the ground.
const LEAF = ["#d8642a", "#e8a03a", "#b8401e", "#c8902a", "#8a3a1a"];
// Leaves that fall through the strip and drift sideways with the wind. n is the
// number of leaves, and seed changes their places.
function leaves(p: Px, W: number, seed: number, n: number, t: number, wind: number): void {
  for (let i = 0; i < n; i++) {
    const k = i * 7 + seed;
    const y = (t * (2 + rnd(k + 1) * 3) + rnd(k + 2) * H) % H;
    const x = ((rnd(k) * W + t * wind + Math.sin(t * 2 + i) * 3) % W + W) % W;
    p(Math.floor(x), Math.floor(y), 1 + (i % 2), 1, LEAF[i % 5]);
  }
}
// A tree with a round crown. The crown has radius r, and its top is at row top.
// The trunk stands at x and reaches row 20. colors are the colors of the crown.
function broadTree(p: Px, x: number, top: number, r: number, colors: string[], trunk = "#4a2e1a"): void {
  p(x, top + r, 2, 20 - top - r, trunk);
  for (let y = -r; y <= r; y++) {
    const w = Math.round(Math.sqrt(r * r - y * y) * 1.3);
    for (let dx = -w; dx <= w; dx += 2) p(x + dx, top + r + y, 2, 1, colors[(dx + y + 40) % colors.length]);
  }
}
// Five bands of fog that drift to the right at different speeds and wrap at the
// edges. The bands lie at y0, y0 + 2, and y0 + 4, and they repeat. alpha is the
// opacity of the fog.
function fog(p: Px, a: Alpha, W: number, t: number, y0: number, color: string, alpha: number): void {
  a(alpha);
  for (let i = 0; i < 5; i++) {
    const x = ((t * (4 + i) + i * W / 5) % (W + 60)) - 30;
    p(Math.round(x), y0 + (i % 3) * 2, 40, 2, color);
  }
  a(1);
}

// The Thing in the Fog, a nod to The X-Files. Three layers of fog drift over a
// row of autumn trees. A dark monster with long arms and red eyes stands in the
// fog. It is hard to see for 5 s, comes into view, steps closer, and then fades
// out. Two agents in coats walk toward it and aim light beams at it. The beams
// point at the monster only while it is in view. The loop is 16 s.
function fogThing(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, 8, "#2a2630");
  p(0, 8, W, 8, "#3a3438");
  p(0, 16, W, 8, "#221a16");
  for (let i = 0; i < 6; i++) broadTree(p, Math.round(W * (0.04 + i * 0.18)), 6 + (i % 2) * 2, 4 + (i % 2), ["#6a3a20", "#8a4a22", "#4a2a18"]);
  fog(p, a, W, t * 0.6, 4, "#b8b0b8", 0.22);
  const mx = Math.round(W * 0.7);
  const seen = u > 7 && u < 13;
  const near = u > 9.5 && u < 12 ? Math.min(1, (u - 9.5) / 1.5) : 0;
  const vis = u < 5 ? 0.15 : u < 7 ? 0.15 + (u - 5) * 0.2 : u < 13 ? 0.95 : Math.max(0, 0.95 - (u - 13) * 0.5);
  const x = mx - Math.round(near * W * 0.06);
  a(vis);
  const c = "#120c0c";
  p(x, 5, 4, 4, c);
  p(x - 1, 6, 1, 1, c);
  p(x + 4, 6, 1, 1, c);
  p(x - 2, 9, 8, 6, c);
  p(x - 1, 15, 2, 5, c);
  p(x + 3, 15, 2, 5, c);
  const sway = Math.round(Math.sin(t * 1.4) * 1);
  p(x - 4, 10 + sway, 2, 8, c);
  p(x + 6, 10 - sway, 2, 8, c);
  p(x - 5, 18 + sway, 1, 2, c);
  p(x + 8, 18 - sway, 1, 2, c);
  a(1);
  if (vis > 0.3) {
    const g = Math.floor(t * 1.5) % 6 === 0 ? "#120c0c" : seen ? "#ff4a2a" : "#a8382a";
    p(x, 6, 1, 1, g);
    p(x + 3, 6, 1, 1, g);
  }
  const ax = Math.round(W * 0.18 + Math.min(u, 6) * W * 0.03);
  const agents: [number, string, string, number][] = [
    [ax, "#2a2e33", "#3a2a1e", 11],
    [ax + 7, "#3a3530", "#b5452a", 12],
  ];
  agents.forEach(([fx, coat, hair, top], i) => {
    p(fx, top, 2, 2, "#c9a184");
    p(fx, top, 2, 1, hair);
    p(fx - 1, top + 2, 4, 5, coat);
    const st = u < 6 ? Math.floor(t * 4 + i) % 2 : 0;
    p(fx + st, top + 7, 1, 20 - top - 7, coat);
    p(fx + 2 - st, top + 7, 1, 20 - top - 7, coat);
    const reach = Math.max(10, x - fx - 3);
    const aim = seen ? (8 - top - 2) / reach : Math.sin(t * 1.2 + i * 2) * 0.12;
    for (let k = 0; k < reach; k++) {
      a(0.26 * (1 - k / reach));
      p(fx + 3 + k, Math.round(top + 2 + k * aim) - Math.floor(k / 8), 1, 1 + Math.floor(k / 4), "#fff3c4");
    }
    a(1);
  });
  fog(p, a, W, t, 10, "#c8c0c8", 0.28);
  fog(p, a, W, t * 1.4 + 20, 16, "#d8d0d4", 0.38);
  leaves(p, W, 3, 8, t, 3);
  sign(p, W, "#2a2630", "#6a4a3a", "#e8d8c8");
}

// The Duel in the Garden, a nod to Kill Bill Vol. 1. In a pale garden, a red
// maple stands to the left of the sign. A stone lantern and a pond stand to the
// right. A fighter in yellow and a fighter in white walk to the maple and cross
// swords, and sparks flash. At 9 s the strip flashes white and the red leaves
// of the maple scatter. The loop is 14 s.
function duel(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 14;
  p(0, 0, W, H, "#e8e0d0");
  p(0, 18, W, 6, "#c8c0a8");
  p(0, 18, W, 1, "#a89878");
  const tx = Math.round(W * 0.27);
  p(tx - 1, 6, 3, 12, "#3a2418");
  for (let i = 0; i < 40; i++) p(tx - 18 + Math.floor(rnd(i) * 36), 1 + Math.floor(rnd(i + 3) * 7), 3, 2, ["#c82020", "#e04a2a", "#a81818"][i % 3]);
  const lx = Math.round(W * 0.64);
  p(lx, 12, 4, 1, "#6a6a62");
  p(lx + 1, 13, 2, 3, "#8a8a80");
  p(lx - 1, 16, 6, 2, "#6a6a62");
  p(lx + 1, 14, 2, 1, "#ffd890");
  p(Math.round(W * 0.76), 19, 30, 2, "#5a8aa8");
  const meet = Math.min(1, u / 4);
  const ax = Math.round(tx - 26 + meet * 18), bx = Math.round(tx + 24 - meet * 18);
  const clash = u >= 4 && u < 9;
  p(ax, 11, 2, 2, "#e8c070");
  p(ax - 1, 13, 4, 5, "#e8d020");
  p(ax - 1, 15, 4, 1, "#1a1a1a");
  p(ax, 18, 1, 1, "#1a1a1a");
  p(ax + 2, 18, 1, 1, "#1a1a1a");
  p(bx, 11, 2, 2, "#d8b090");
  p(bx, 11, 2, 1, "#1a1a1a");
  p(bx - 1, 13, 4, 5, "#f0f0e8");
  p(bx, 18, 1, 1, "#d8d0c0");
  p(bx + 2, 18, 1, 1, "#d8d0c0");
  const raise = clash ? (Math.floor(t * 3) % 2) : 0;
  p(ax + 3, 12 - raise, 5, 1, "#e8e8f0");
  p(bx - 5, 12 - raise, 5, 1, "#e8e8f0");
  if (clash && Math.floor(t * 3) % 2 === 0) {
    p(tx - 1, 10, 3, 3, "#fff6c0");
    p(tx - 3, 11, 1, 1, "#ffd23a");
    p(tx + 3, 11, 1, 1, "#ffd23a");
  }
  if (u >= 9 && u < 9.3) {
    a(0.5);
    p(0, 0, W, H, "#ffffff");
    a(1);
  }
  const burst = u >= 9 ? Math.min(1, (u - 9) / 3) : 0;
  for (let i = 0; i < 24; i++) {
    const k = i * 3;
    const fx = tx - 14 + rnd(k) * 28 + burst * (rnd(k + 1) - 0.5) * 30;
    const fy = (rnd(k + 2) * 8 + t * (2 + rnd(k + 3) * 2) + burst * 6) % 18;
    p(Math.round(fx), Math.round(fy), 1, 1, ["#c82020", "#e04a2a"][i % 2]);
  }
  sign(p, W, "#e8e0d0", "#a81818", "#3a2418");
}

// The Vineyard, a nod to Star Trek: The Next Generation. At dusk, a stone
// château with lit windows stands on the left, and two rows of vines with
// grapes sway in the wind. A bald man in a red and black uniform top, with a
// small gold badge, picks grapes into a basket. From 11 s to 12.5 s the badge
// chirps: it flashes and two sparks flicker beside him. He touches the badge
// and a column of light takes him away from 13 s to 15 s. The basket stays. A
// starship then glides across the sky. The loop is 24 s.
function vineyard(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 24;
  ["#3a2e5a", "#6a4a6a", "#b0606a", "#e08a5a", "#f4b46a"].forEach((c, i) => p(0, i * 3, W, 3, c));
  disc(p, Math.round(W * 0.82), 12, 3.5, "#ffe0a0", 13);
  for (let x = 0; x < W; x++) {
    const h = Math.round(3 + 2 * Math.sin(x * 0.025 + 1) + Math.sin(x * 0.07));
    p(x, 13 - h, 1, h, "#7a5a6a");
  }
  for (let x = 0; x < W; x++) {
    const h = Math.round(2 + 1.5 * Math.sin(x * 0.04 + 3));
    p(x, 14 - h, 1, h + 10, "#5a6a32");
  }
  const cx = Math.round(W * 0.07);
  p(cx, 6, 16, 8, "#d8c8a0");
  p(cx - 1, 5, 18, 1, "#6a6070");
  p(cx + 11, 2, 5, 4, "#d8c8a0");
  p(cx + 10, 1, 7, 1, "#6a6070");
  p(cx + 13, 0, 1, 1, "#6a6070");
  for (let i = 0; i < 3; i++) p(cx + 2 + i * 4, 8, 2, 2, "#ffcf6a");
  p(cx + 12, 3, 2, 2, "#ffcf6a");
  p(cx + 6, 11, 3, 3, "#4a3020");
  const wind = Math.sin(t * 0.6);
  for (let r = 0; r < 2; r++) {
    const y = 15 + r * 4;
    p(0, y, W, 1, "#8a7a5a");
    for (let x = 2 + r * 3; x < W; x += 9) {
      p(x, y, 1, 4, "#5a4030");
      for (let k = 0; k < 4; k++) p(x + 1 + k * 2 + Math.round(wind * (k % 2)), y - 1 + (k % 2), 2, 1, (k + x) % 3 ? "#4a7a2a" : "#6a8a2a");
    }
  }
  const picking = u < 11;
  const steps = Math.min(5, Math.floor(u / 2.2));
  const px = Math.round(W * 0.34 + steps * 6);
  const bunches = [];
  for (let i = 0; i < 9; i++) bunches.push(Math.round(W * 0.34) + i * 6 + 4);
  bunches.forEach((bx, i) => {
    if (i < steps) return;
    p(bx, 16, 2, 2, "#5a2a6a");
    p(bx, 16, 1, 1, "#8a4a9a");
    p(bx + 1, 18, 1, 1, "#5a2a6a");
  });
  for (let i = 0; i < 5; i++) {
    const bx = Math.round(W * 0.6) + i * 10;
    p(bx, 20, 2, 2, "#5a2a6a");
    p(bx, 20, 1, 1, "#8a4a9a");
  }
  const gone = u >= 15;
  const beam = u >= 13 && u < 15;
  const basketX = picking ? px - 5 : Math.round(W * 0.34 + 5 * 6) - 5;
  p(basketX, 17, 4, 3, "#8a5a2a");
  p(basketX, 17, 4, 1, "#a87a3a");
  if (u > 2) p(basketX, 16, Math.min(4, 1 + steps), 1, "#5a2a6a");
  const mx = picking ? px : Math.round(W * 0.34 + 5 * 6);
  if (!gone) {
    a(beam ? Math.max(0, 1 - (u - 13) / 1.6) : 1);
    p(mx, 9, 3, 3, "#d8a888");
    p(mx, 10, 1, 1, "#a8a8a0");
    p(mx + 2, 10, 1, 1, "#a8a8a0");
    p(mx - 1, 12, 5, 2, "#1a1a1e");
    p(mx - 1, 14, 5, 3, "#a81e1e");
    p(mx, 12, 3, 2, "#a81e1e");
    const glint = u >= 11 && u < 12.5 && Math.floor(t * 8) % 2 === 0;
    p(mx, 13, 1, 1, glint ? "#ffffff" : "#e8c050");
    p(mx, 17, 1, 3, "#1a1a1e");
    p(mx + 2, 17, 1, 3, "#1a1a1e");
    if (picking) {
      const reach = Math.floor(t * 0.9) % 2;
      p(mx + 4, 15 - reach, 1, 2, "#d8a888");
    }
    else if (u >= 12 && u < 13.5) p(mx + 1, 13, 1, 1, "#d8a888");
    a(1);
    if (u >= 11 && u < 12.5) for (let k = 1; k <= 2; k++) if (Math.floor(t * 6) % 2) {
      p(mx - 1 - k * 2, 12 - k, 1, 1, "#ffe8a0");
      p(mx + 3 + k * 2, 12 - k, 1, 1, "#ffe8a0");
    }
  }
  if (beam) {
    a(0.3);
    p(mx - 2, 8, 7, 12, "#ffe8a0");
    a(1);
    for (let i = 0; i < 12; i++) {
      const k = i + Math.floor(t * 14) * 12;
      p(mx - 2 + Math.floor(rnd(k) * 7), 8 + Math.floor(rnd(k + 1) * 12), 1, 1, rnd(k + 2) > 0.5 ? "#ffe8a0" : "#8ad0ff");
    }
  }
  if (u >= 15 && u < 23) {
    const e = (u - 15) / 8, sx = Math.round(-14 + e * (W + 28)), sy = 4;
    p(sx + 6, sy, 8, 1, "#c8ccd4");
    p(sx + 5, sy + 1, 10, 1, "#a8b0ba");
    p(sx + 3, sy + 2, 3, 1, "#8a929c");
    p(sx, sy + 3, 6, 1, "#c8ccd4");
    p(sx + 6, sy + 3, 1, 1, "#ff5a3a");
    p(sx - 1, sy + 3, 1, 1, "#4aa3ff");
  }
  sign(p, W, "#3a2e5a", "#a8582a", "#ffe0a0");
}

// 129-25: Returns the color between the hex colors a and b as an rgb() string.
// f is the share of b, from 0 (a) to 1 (b). A value outside this range counts
// as the nearest end.
function mix(a: string, b: string, f: number): string {
  const hex = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const A = hex(a), B = hex(b), k = Math.max(0, Math.min(1, f));
  return "rgb(" + A.map((v, i) => Math.round(v + (B[i] - v) * k)).join(",") + ")";
}
// 129-25: Draws a line from x0, y0 to x1, y1 in the color c. The line has the
// width of one pixel, and its ends are on the grid.
function line(p: Px, x0: number, y0: number, x1: number, y1: number, c: string): void {
  const n = Math.max(1, Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= n; i++) p(Math.round(x0 + (x1 - x0) * i / n), Math.round(y0 + (y1 - y0) * i / n), 1, 1, c);
}

// 129-25: One walker of Leaving the Valley. h is the height in pixels, and w is
// the width of the body, 4 by default. body, skin, and hair are colors. The
// optional fields add a hat, a helmet, a beard, a staff, a bow, or a shield.
interface Walker {
  h: number;
  w?: number;
  body: string;
  skin: string;
  hair: string;
  hat?: string;
  helm?: string;
  beard?: string;
  staff?: boolean;
  bow?: boolean;
  shield?: boolean;
}
// 129-25: Draws the walker o with its head at column x and its feet on row g. The
// feet change place four times each second at time t. i shifts the step, so
// two walkers do not step together.
function walker(p: Px, x: number, g: number, o: Walker, t: number, i: number): void {
  const w = o.w ?? 4, top = g - o.h, st = Math.floor(t * 4 + i) % 2;
  if (o.staff) p(x + 3, top - 1, 1, o.h + 1, "#8a6a4a");
  if (o.bow) p(x - 2, top + 1, 1, 5, "#9a7a3a");
  p(x, top, 2, 2, o.skin);
  p(x, top, 2, 1, o.hair);
  if (o.hat) {
    p(x - 1, top, 4, 1, o.hat);
    p(x, top - 1, 2, 1, o.hat);
    p(x + 1, top - 2, 1, 1, o.hat);
  }
  if (o.helm) p(x, top, 2, 1, o.helm);
  p(x + 1 - Math.floor(w / 2), top + 2, w, o.h - 4, o.body);
  if (o.beard) p(x, top + 2, 2, 2, o.beard);
  if (o.shield) p(x - 2, top + 3, 2, 3, "#b89a4a");
  p(x + st, g - 2, 1, 2, "#2a2018");
  p(x + 2 - st, g - 2, 1, 2, "#2a2018");
}
// 129-25: The nine walkers of Leaving the Valley, in the order of the line. The
// first one walks in front.
const COMPANY: Walker[] = [
  { h: 10, body: "#8a8a8a", skin: "#d8b8a0", hair: "#d0d0d0", hat: "#7a7a7a", staff: true },
  { h: 6, w: 3, body: "#6a4a2a", skin: "#e0b890", hair: "#4a2a1a" },
  { h: 6, w: 3, body: "#4a5a2a", skin: "#e0b890", hair: "#c89a5a" },
  { h: 6, w: 3, body: "#7a5a3a", skin: "#e0b890", hair: "#6a4a2a" },
  { h: 6, w: 3, body: "#5a4a3a", skin: "#e0b890", hair: "#3a2418" },
  { h: 9, body: "#2e3a2a", skin: "#c8a080", hair: "#2a1e16" },
  { h: 9, body: "#4a6a3a", skin: "#e8d0b0", hair: "#f0e0a0", bow: true },
  { h: 6, w: 5, body: "#6a3a2a", skin: "#d8a888", hair: "#a84a1a", helm: "#8a8a90", beard: "#a84a1a" },
  { h: 9, body: "#7a2a22", skin: "#d0a888", hair: "#6a4a2a", shield: true },
];

// Leaving the Valley, a nod to The Lord of the Rings: The Fellowship of the
// Ring. At dusk, a pale hall with arches stands on the left of a valley with
// two waterfalls and golden trees. Nine walkers leave the hall in a line: a
// grey figure with a pointed hat and a staff, four small ones, a ranger, an
// archer, a short bearded one in a helmet, and a man with a round shield. They
// step up onto a stone bridge over a stream and walk out to the right. Gold
// leaves fall. The loop is 20 s.
function valley(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 20;
  ["#2e2a4a", "#4e3a5e", "#8a4e5e", "#c87a52", "#eaa862"].forEach((c, i) => p(0, i * 3, W, 3, c));
  p(0, 15, W, 4, "#eaa862");
  for (let x = 0; x < W; x++) {
    const h = Math.round(8 + 3 * Math.sin(x * 0.031 + 0.5) + 1.5 * Math.sin(x * 0.13));
    p(x, 19 - h, 1, h, "#4a3e56");
  }
  for (const f of [0.14, 0.88]) {
    const wx = Math.round(W * f);
    for (let y = 9; y < 19; y++) p(wx, y, 2, 1, ((Math.floor(y - t * 10) % 3) + 3) % 3 ? "#a8c4d8" : "#eaf4ff");
  }
  for (let x = 0; x < W; x++) {
    const h = Math.round(3 + 1.5 * Math.sin(x * 0.05 + 2));
    p(x, 19 - h, 1, h, "#3a3248");
  }
  const hx = Math.round(W * 0.02);
  p(hx + 4, 5, 18, 2, "#cdbb98");
  p(hx + 11, 3, 4, 2, "#cdbb98");
  p(hx + 12, 2, 2, 1, "#cdbb98");
  p(hx - 1, 7, 27, 1, "#d8c8a8");
  for (let i = 0; i < 4; i++) {
    const cx = hx + i * 6;
    a(0.4);
    p(cx + 1, 10, 5, 9, "#ffd890");
    a(1);
    p(cx + 1, 9, 1, 1, "#efe4c8");
    p(cx + 2, 8, 2, 1, "#efe4c8");
    p(cx + 4, 9, 1, 1, "#efe4c8");
  }
  for (let i = 0; i < 5; i++) p(hx + i * 6, 8, 1, 11, "#efe4c8");
  for (const f of [0.34, 0.66, 0.78]) broadTree(p, Math.round(W * f), 7, 4, ["#e8b040", "#d8902a", "#f0c860"], "#4a3424");
  p(0, 19, W, 5, "#3a3a22");
  p(0, 19, W, 1, "#5a5a2e");
  const sx = Math.round(W * 0.42), sw = 22;
  p(sx, 19, sw, 5, "#4a6a88");
  for (let i = 0; i < 3; i++) p(sx + 2 + ((Math.floor(t * 3) + i * 7) % (sw - 4)), 20 + i, 2, 1, "#8ab0c8");
  p(sx - 3, 17, sw + 6, 2, "#d8c8a8");
  p(sx - 3, 15, sw + 6, 1, "#efe4c8");
  for (let k = 0; k <= sw + 6; k += 4) p(sx - 3 + k, 16, 1, 1, "#efe4c8");
  p(sx + 2, 19, sw - 4, 1, "#3a5a78");
  const lead = -6 + (u / 20) * (W + 80);
  COMPANY.forEach((o, i) => {
    const x = Math.round(lead - i * 7);
    const onBridge = x >= sx - 3 && x <= sx + sw + 2;
    walker(p, x, onBridge ? 17 : 19, o, t, i);
  });
  leaves(p, W, 9, 10, t, 2);
  sign(p, W, "#2e2a4a", "#c8a050", "#f0e0b0");
}

// The Leaf Pile, a nod to Peanuts. A kid in a yellow zigzag shirt rakes a pile
// of leaves, and the pile grows from 0 s to 6 s. A white beagle lies on the
// roof of a red doghouse. At 6 s it jumps down and runs, and at 7.8 s it dives
// into the pile. The leaves burst and land. From 9 s the kid slumps and the
// rake lies on the ground. The beagle rolls in the leaves until 10 s, walks
// back from 10 s to 13 s, and lies on the roof again from 13.4 s. The loop is
// 16 s.
function leafPile(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, 16, "#a8d4ec");
  p(0, 16, W, 8, "#7aa84a");
  p(0, 16, W, 1, "#9ac060");
  broadTree(p, Math.round(W * 0.1), 2, 5, ["#e8862a", "#f0b03a", "#d8562a"], "#6a4a2a");
  broadTree(p, Math.round(W * 0.93), 3, 4, ["#e8862a", "#d8562a", "#c8902a"], "#6a4a2a");
  for (let i = 0; i < 14; i++) p(Math.floor(rnd(i + 40) * W), 18 + Math.floor(rnd(i + 41) * 5), 2, 1, LEAF[i % 5]);
  const dh = Math.round(W * 0.72);
  p(dh, 13, 12, 7, "#c8282a");
  p(dh + 4, 15, 4, 5, "#2a1a1a");
  p(dh + 5, 14, 2, 1, "#2a1a1a");
  for (let k = 0; k < 5; k++) p(dh - 1 + k, 12 - k, 14 - k * 2, 1, "#4a2a22");
  const px = Math.round(W * 0.38);
  const burstAt = 7.8, e = u - burstAt;
  if (u < burstAt) {
    const ph = 1 + Math.round(Math.min(1, u / 6) * 3);
    for (let y = 0; y < ph; y++) {
      const w = (ph - y) * 3 + 2;
      for (let k = 0; k < w; k++) p(px - Math.floor(w / 2) + k, 19 - y, 1, 1, LEAF[(k + y * 2) % 5]);
    }
  } else {
    for (let i = 0; i < 34; i++) {
      const vx = (rnd(i + 70) - 0.5) * 26, vy = 6 + rnd(i + 71) * 9;
      const land = (vy + Math.sqrt(vy * vy + 72)) / 18;
      const s = Math.min(e, land);
      const x = px + vx * s, y = 17 - vy * s + 9 * s * s;
      p(Math.round(x), Math.min(19 + (i % 3), Math.round(y)), 1 + (i % 2), 1, LEAF[i % 5]);
    }
  }
  const kx = px - 13, slump = u >= 9 ? 1 : 0;
  p(kx - 1, 9 + slump, 4, 4, "#f0c8a0");
  p(kx + 1, 9 + slump, 1, 1, "#6a4a2a");
  p(kx + 2, 11 + slump, 1, 1, "#2a1a10");
  p(kx - 1, 13 + slump, 4, 4 - slump, "#f0d020");
  for (let k = 0; k < 4; k++) p(kx - 1 + k, 14 + slump + (k % 2), 1, 1, "#1a1a1a");
  p(kx - 1, 17, 4, 1, "#2a2a2a");
  p(kx, 18, 1, 2, "#f0c8a0");
  p(kx + 2, 18, 1, 2, "#f0c8a0");
  if (u < 9) {
    const rk = u < 6 ? Math.round(Math.sin(t * 4) * 2) : 0;
    line(p, kx + 3, 14, kx + 9 + rk, 19, "#8a6a3a");
    p(kx + 8 + rk, 19, 3, 1, "#5a5a5a");
    p(kx + 3, 14, 1, 1, "#f0c8a0");
  } else {
    p(kx + 4, 19, 8, 1, "#8a6a3a");
    p(kx + 12, 19, 1, 1, "#5a5a5a");
    p(kx + 3, 15 + slump, 1, 2, "#f0c8a0");
  }
  const lying = (x: number, y: number) => {
    p(x, y - 1, 6, 2, "#f4f4f0");
    p(x - 1, y - 2, 2, 2, "#f4f4f0");
    p(x - 2, y - 2, 1, 1, "#1a1a1a");
    p(x, y - 1, 1, 2, "#1a1a1a");
    p(x + 1, y - 2, 1, 1, "#f4f4f0");
    p(x + 4, y - 2, 1, 1, "#f4f4f0");
  };
  const stand = (x: number, y: number, run: boolean) => {
    p(x, y - 3, 5, 2, "#f4f4f0");
    p(x - 2, y - 5, 3, 3, "#f4f4f0");
    p(x - 3, y - 4, 1, 1, "#1a1a1a");
    p(x, y - 5, 1, 2, "#1a1a1a");
    p(x + 5, y - 4, 1, 1, "#f4f4f0");
    const s = run ? Math.floor(t * 10) % 2 : 0;
    p(x + s, y - 1, 1, 1, "#f4f4f0");
    p(x + 4 - s, y - 1, 1, 1, "#f4f4f0");
  };
  if (u < 6 || u >= 13.4) lying(dh + 3, 7);
  else if (u < 6.5) stand(dh - 2, Math.round(8 + (u - 6) * 22), false);
  else if (u < 7.3) stand(Math.round(dh - 2 - (u - 6.5) / 0.8 * (dh - 2 - (px + 8))), 20, true);
  else if (u < burstAt) {
    const f = (u - 7.3) / 0.5;
    stand(Math.round(px + 8 - f * 8), Math.round(20 - Math.sin(f * Math.PI) * 8), false);
  } else if (u < 10) lying(px - 2, 20 - Math.abs(Math.round(Math.sin(t * 9))));
  else if (u < 13) stand(Math.round(px + (u - 10) / 3 * (dh - 2 - px)), 20, true);
  else stand(dh - 2, Math.round(20 - (u - 13) / 0.4 * 12), false);
  leaves(p, W, 11, 6, t * 0.7, 2);
  sign(p, W, "#fff4e0", "#c8282a", "#3a2a1a");
}

// The Quiet Pond, a nod to Stargate SG-1. On an evening at a pond, a man in a
// cap sits in a green and white folding chair with a fishing rod. A cooler
// with a bottle stands beside him. A leaf falls from 2 s, lands on the water at
// 5.5 s, and rings spread until 9 s. The bobber never moves. From 9 s to 11.5 s
// he drinks from the bottle. No fish comes. The loop is 16 s.
function pond(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 16;
  ["#5a6a9a", "#8a7aa0", "#c890a0", "#f0b08a"].forEach((c, i) => p(0, i * 4, W, 4, c));
  for (let x = 0; x < W; x += 2) {
    const h = Math.round(5 + 2 * Math.sin(x * 0.09) + Math.sin(x * 0.23) * 1.5);
    p(x, 16 - h, 2, h, ["#7a4a22", "#5a4a22", "#8a5a24", "#3a4a22"][Math.floor(x / 7) % 4]);
  }
  p(0, 16, W, 8, "#4a6a2e");
  p(0, 16, W, 1, "#6a8a3a");
  broadTree(p, Math.round(W * 0.2), 4, 5, ["#d8762a", "#e8a03a", "#b8401e"]);
  const qx = Math.round(W * 0.6), qw = Math.round(W * 0.3);
  for (let y = 17; y < 23; y++) {
    const d = (y - 19.5) / 3.2;
    const w = Math.round(qw * Math.sqrt(Math.max(0, 1 - d * d)));
    p(qx + Math.round((qw - w) / 2), y, w, 1, "#3a6a8a");
  }
  for (let i = 0; i < 4; i++) p(qx + Math.round(qw * (0.2 + i * 0.18) + Math.sin(t * 0.7 + i) * 2), 18 + (i % 3) * 1.5, 3, 1, "#6a9ab8");
  const bx = qx + Math.round(qw * 0.3);
  const lu = u - 2;
  if (lu >= 0 && lu < 3.5) p(Math.round(bx + 9 + Math.sin(lu * 2.4) * 3), Math.round(lu / 3.5 * 19), 2, 1, "#e8a03a");
  if (u >= 5.5 && u < 9) {
    const r = (u - 5.5) * 3;
    a(Math.max(0, 0.7 - (u - 5.5) * 0.2));
    p(Math.round(bx + 9 - r), 19, 1, 1, "#a8d0e8");
    p(Math.round(bx + 10 + r), 19, 1, 1, "#a8d0e8");
    p(Math.round(bx + 9 - r * 0.6), 18, 1, 1, "#a8d0e8");
    p(Math.round(bx + 10 + r * 0.6), 20, 1, 1, "#a8d0e8");
    a(1);
  }
  if (u >= 5.5) p(bx + 9, 19, 2, 1, "#e8a03a");
  const cx = qx - 14;
  p(cx - 7, 17, 5, 3, "#3a6ac8");
  p(cx - 7, 17, 5, 1, "#e8e8e8");
  const sip = u >= 9 && u < 11.5;
  if (!sip) p(cx - 5, 15, 1, 2, "#6a3a14");
  p(cx - 1, 12, 2, 5, "#2a7a3a");
  p(cx - 1, 13, 2, 1, "#e8e8e8");
  p(cx - 1, 15, 2, 1, "#e8e8e8");
  p(cx, 17, 6, 1, "#2a7a3a");
  p(cx, 18, 1, 2, "#c8c8c8");
  p(cx + 5, 18, 1, 2, "#c8c8c8");
  p(cx + 1, 10, 3, 3, "#d8a888");
  p(cx + 1, 9, 3, 1, "#4a5a3a");
  p(cx + 4, 10, 1, 1, "#4a5a3a");
  p(cx + 3, 11, 1, 1, "#2a1a10");
  p(cx, 13, 4, 4, "#6a5a3a");
  p(cx + 3, 16, 4, 1, "#3a4a5a");
  p(cx + 6, 17, 1, 2, "#3a4a5a");
  p(cx + 6, 19, 2, 1, "#2a1e14");
  p(cx + 4, 14, 1, 1, "#6a5a3a");
  p(cx + 5, 14, 1, 1, "#d8a888");
  const tipX = cx + 15, tipY = 6;
  line(p, cx + 5, 14, tipX, tipY, "#3a2a1a");
  a(0.55);
  line(p, tipX, tipY, bx, 17, "#f0f0f0");
  a(1);
  p(bx, 17, 1, 1, "#e02020");
  p(bx, 18, 1, 1, "#f0f0f0");
  if (sip) {
    p(cx + 3, 12, 1, 2, "#6a5a3a");
    p(cx + 4, 11, 1, 2, "#6a3a14");
  }
  leaves(p, W, 13, 7, t * 0.8, 2);
  sign(p, W, "#5a6a9a", "#a8582a", "#f8e0b0");
}

// Tea on the Promenade, a nod to Star Trek: Deep Space Nine. In a station, two
// round windows show stars that drift past. At a table sit a man with grey
// ridged skin and a doctor in a black uniform with a blue-green shoulder. The
// doctor sips from 5 s to 7 s. One autumn leaf floats across the station from
// 3 s to 15 s. While the leaf is near the grey man, after 8 s, his brow goes up
// by one pixel. The loop is 16 s.
function promenade(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, H, "#262a34");
  for (let x = 6; x < W; x += 14) p(x, 0, 1, 19, "#323846");
  p(0, 0, W, 1, "#3a4050");
  for (const f of [0.18, 0.84]) {
    const wx = Math.round(W * f), wy = 10;
    disc(p, wx, wy, 9, "#5a606e");
    disc(p, wx, wy, 8, "#04060c");
    for (let i = 0; i < 16; i++) {
      const k = i * 5 + f * 100, sp = 1 + rnd(k) * 3;
      const sxr = Math.round((((rnd(k + 1) * 20 - t * sp) % 20) + 20) % 20 - 10), sy = Math.floor(rnd(k + 2) * 16) - 8;
      if (sxr * sxr + sy * sy < 56) p(wx + sxr, wy + sy, sp > 2.5 ? 2 : 1, 1, sp > 2 ? "#ffffff" : "#8a9ab8");
    }
    p(wx, wy - 8, 1, 17, "#5a606e");
  }
  p(0, 19, W, 5, "#1a1c22");
  p(0, 19, W, 1, "#d8903a");
  const tx = Math.round(W * 0.6);
  p(tx, 15, 9, 1, "#8a8e9a");
  p(tx + 4, 16, 1, 3, "#5a5e6a");
  p(tx + 2, 18, 5, 1, "#5a5e6a");
  const lf = (u - 3) / 12;
  const lx = Math.round(-3 + lf * (W + 6)), ly = Math.round(6 + Math.sin(u * 1.3) * 3);
  const gx = tx - 5;
  const brow = Math.abs(lx - gx) < 18 && u > 8 ? 1 : 0;
  p(gx - 1, 9, 1, 3, "#1a1a1e");
  p(gx, 8, 3, 1, "#1a1a1e");
  p(gx, 9, 3, 3, "#8a929a");
  p(gx + 2, 11, 1, 1, "#0a0a0a");
  p(gx + 2, 10 - brow, 1, 1, "#4a5058");
  p(gx - 1, 12, 1, 1, "#5a6068");
  p(gx + 2, 12, 1, 1, "#5a6068");
  p(gx - 1, 13, 4, 3, "#4a3a4a");
  p(gx, 14, 2, 1, "#6a5a6a");
  p(gx + 2, 16, 3, 1, "#2a2a30");
  p(gx + 4, 17, 1, 2, "#2a2a30");
  p(gx - 1, 16, 3, 3, "#5a5e6a");
  const dx = tx + 11;
  const sipping = u >= 5 && u < 7;
  p(dx, 8, 3, 1, "#1a1410");
  p(dx + 3, 9, 1, 2, "#1a1410");
  p(dx, 9, 3, 3, "#a8784e");
  p(dx, 11, 1, 1, "#0a0a0a");
  p(dx - 1, 12, 5, 4, "#1a1a1e");
  p(dx - 1, 12, 5, 1, "#3a9aa8");
  p(dx - 3, 16, 3, 1, "#1a1a1e");
  p(dx - 3, 17, 1, 2, "#1a1a1e");
  p(dx + 1, 16, 3, 3, "#5a5e6a");
  p(tx + 1, 14, 1, 1, "#e8e8e8");
  if (sipping) {
    p(dx - 2, 13, 1, 1, "#1a1a1e");
    p(dx - 1, 11, 1, 1, "#e8e8e8");
  } else p(tx + 7, 14, 1, 1, "#e8e8e8");
  a(0.45);
  for (let i = 0; i < 2; i++) {
    p(tx + 1 + Math.round(Math.sin(t * 2 + i)), 13 - ((Math.floor(t * 2) + i) % 2), 1, 1, "#e8e8e8");
    if (!sipping) p(tx + 7 + Math.round(Math.sin(t * 2 + i + 1)), 13 - ((Math.floor(t * 2) + i + 1) % 2), 1, 1, "#e8e8e8");
  }
  a(1);
  if (u >= 3 && u < 15) {
    p(lx, ly, 2, 1, "#d8642a");
    p(lx + (Math.floor(t * 3) % 2), ly - 1, 1, 1, "#e8a03a");
  }
  sign(p, W, "#262a34", "#d8903a", "#e8e0c8");
}

// The Wait, a nod to Futurama. A small brown dog sits outside a pizzeria that
// has a green and white striped awning and no lettering. A stranger walks past
// from 2 s to 8 s. While the stranger is near, the dog lifts its head and wags.
// The sky is day until 9 s, dusk from 9 s to 13 s, night from 13 s to 21 s, and
// day again from 21 s to 24 s. The shop window and the door glass are lit until
// 12 s and from 22 s. The street lamp is on from 10.5 s to 22 s. At night the
// head of the dog drops by one pixel, stars show, and one upper window is lit.
// Leaves gather around the dog as the loop goes on. The dog stays. The loop is
// 24 s.
function theWait(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 24;
  const DAY = "#9ac4e4", DUSK = "#e0905a", NIGHT = "#141a32";
  const sky = u < 9 ? DAY : u < 11 ? mix(DAY, DUSK, (u - 9) / 2) : u < 13 ? mix(DUSK, NIGHT, (u - 11) / 2) : u < 21 ? NIGHT : mix(NIGHT, DAY, (u - 21) / 3);
  const dark = u < 9 ? 0 : u < 13 ? (u - 9) / 4 * 0.6 : u < 21 ? 0.6 : 0.6 * (1 - (u - 21) / 3);
  const lampOn = u >= 10.5 && u < 22;
  const open = u < 12 || u >= 22;
  p(0, 0, W, H, sky);
  for (let i = 0; i < 14; i++) {
    const bw = Math.floor(W / 13), bh = 6 + Math.floor(rnd(i + 60) * 8);
    p(i * bw - 6, 19 - bh, bw - 2, bh, "#6a7a8a");
  }
  const sx = Math.round(W * 0.6), sw = 46;
  p(sx, 5, sw, 14, "#9a4a32");
  for (let y = 6; y < 19; y += 2) p(sx, y, sw, 1, "#8a4028");
  p(sx - 1, 4, sw + 2, 1, "#6a3020");
  for (let k = 0; k < 4; k++) p(sx + 4 + k * 11, 6, 4, 3, "#2a2a3a");
  for (let k = 0; k < sw + 2; k += 2) p(sx - 1 + k, 10, 2, 2, (k / 2) % 2 ? "#f0f0e8" : "#2a7a3a");
  p(sx + 3, 13, 22, 5, open ? "#e8b060" : "#2a2018");
  p(sx + 3, 13, 22, 1, "#5a3020");
  p(sx + 13, 13, 1, 5, "#5a3020");
  const doorX = sx + 28;
  p(doorX, 13, 7, 6, "#2a4a3a");
  p(doorX + 5, 16, 1, 1, "#e8c050");
  p(doorX + 2, 14, 3, 2, open ? "#e8b060" : "#1a2a22");
  p(0, 19, W, 2, "#9a9a96");
  p(0, 21, W, 1, "#6a6a66");
  p(0, 22, W, 2, "#34343a");
  const lx = sx + sw + 6;
  p(lx, 8, 1, 11, "#3a3a3a");
  p(lx - 2, 7, 4, 1, "#3a3a3a");
  const walkX = Math.round(-4 + (u - 2) / 6 * (W + 8));
  const passing = u >= 2 && u < 8;
  if (passing) {
    const st = Math.floor(t * 4) % 2;
    p(walkX, 10, 2, 2, "#d8a888");
    p(walkX, 10, 2, 1, "#4a2a1a");
    p(walkX - 1, 12, 4, 5, "#4a5a7a");
    p(walkX + st, 17, 1, 2, "#2a2a30");
    p(walkX + 2 - st, 17, 1, 2, "#2a2a30");
  }
  const dgx = doorX + 10, g = 19;
  const hopeful = passing && Math.abs(walkX - dgx) < 24;
  const look = hopeful ? 1 : u >= 14 && u < 21 ? -1 : 0;
  for (let i = 0; i < Math.floor(u / 1.6); i++) p(dgx - 10 + Math.floor(rnd(i + 90) * 22), 19 + (i % 2), 1 + (i % 2), 1, LEAF[i % 5]);
  p(dgx + 1, g - 3, 3, 3, "#b07a3a");
  p(dgx + 2, g - 2, 2, 2, "#9a6830");
  p(dgx + 1, g - 1, 1, 1, "#d8a868");
  p(dgx - 1, g - 5 - look, 3, 2, "#b07a3a");
  p(dgx - 2, g - 4 - look, 1, 1, "#d8a868");
  p(dgx - 2, g - 5 - look, 1, 1, "#1a1008");
  p(dgx + 1, g - 6 - look, 1, 1, "#6a4020");
  p(dgx, g - 5 - look, 1, 1, "#1a1008");
  if (u < 2 || hopeful) p(dgx + 4, g - 2 - (Math.floor(t * 6) % 2), 1, 1, "#b07a3a");
  else p(dgx + 4, g - 1, 2, 1, "#b07a3a");
  if (dark > 0) {
    a(dark);
    p(0, 0, W, H, "#06081a");
    a(1);
  }
  if (u >= 13 && u < 21) {
    stars(p, W, 5, Math.floor(W / 20), 4, t);
    p(sx + 15, 6, 4, 3, "#ffd890");
  }
  p(lx - 1, 8, 3, 1, lampOn ? "#ffe8a0" : "#8a8a8a");
  if (lampOn) {
    a(0.2);
    for (let y = 9; y < 21; y++) {
      const w = 3 + (y - 9) * 2;
      p(lx - Math.floor(w / 2), y, w, 1, "#ffe0a0");
    }
    a(1);
  }
  leaves(p, W, 17, 7, t * 0.8, 1.5);
  sign(p, W, "#2a3040", "#2a7a3a", "#f0e8d8");
}

/** LATEAUTUMN holds the late-autumn scenes, in the order of rotation. Each name is unique. */
export const LATEAUTUMN: Script[] = [
  { name: "The Thing in the Fog", period: 16, still: 10, draw: fogThing },
  { name: "The Duel in the Garden", period: 14, still: 6, draw: duel },
  { name: "The Vineyard", period: 24, still: 13.5, draw: vineyard },
  { name: "Leaving the Valley", period: 20, still: 9, draw: valley },
  { name: "The Leaf Pile", period: 16, still: 8.5, draw: leafPile },
  { name: "The Quiet Pond", period: 16, still: 10, draw: pond },
  { name: "Tea on the Promenade", period: 16, still: 10.5, draw: promenade },
  { name: "The Wait", period: 24, still: 16, draw: theWait },
];

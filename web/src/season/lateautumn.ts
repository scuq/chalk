// chalk-web -- 129-23: the seven late-autumn scenes.
//
// On 16 to 22 November, the "late-autumn" key shows one of these scenes. Each
// scene is a nod to a film, a series, or a game, and a person knows it by one
// moment in autumn. Five scenes nod to a film or a series, and two nod to a
// game. A scene has no title, no logo, no lettering, and no likeness of an
// actor. A character is generic. The only text is the CHALK sign. A scene is a
// Script (strip.ts). scene.ts runs these scripts in place of rows for the
// "late-autumn" key.

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

// Coffee and the Owl, a nod to Twin Peaks. In a dark pine forest, a figure in a
// dark suit stands on a floor with a zigzag pattern. The figure holds a white
// cup, and steam rises from it. From 5 s to 8 s the cup goes up to the face.
// An owl sits on a branch and blinks. From 10 s to 13 s its eyes glow and a
// yellow light shows around it. Bands of fog drift past. The loop is 16 s.
function coffee(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, H, "#0a120e");
  for (let i = 0; i < 9; i++) {
    const x = Math.round(i * W / 8) - 4;
    for (let k = 0; k < 6; k++) p(x - k, 3 + k * 3, k * 2 + 1, 3, "#0e2418");
    p(x, 2, 1, 18, "#1a1410");
  }
  p(0, 20, W, 4, "#140e0a");
  for (let x = 0; x < W; x += 4) {
    p(x, 22, 2, 1, "#e8e0d0");
    p(x + 2, 23, 2, 1, "#e8e0d0");
  }
  const cx = Math.round(W * 0.36);
  p(cx, 11, 2, 2, "#d8b090");
  p(cx, 10, 2, 1, "#1a1410");
  p(cx - 1, 13, 4, 5, "#1a1a20");
  p(cx, 13, 2, 2, "#e8e8e0");
  p(cx + 1, 14, 1, 2, "#202020");
  p(cx, 18, 1, 2, "#1a1a20");
  p(cx + 2, 18, 1, 2, "#1a1a20");
  const sip = u > 5 && u < 8;
  const cupX = cx + 3, cupY = sip ? 12 : 15;
  p(cupX, cupY, 2, 2, "#f0f0f0");
  p(cupX + 2, cupY, 1, 1, "#f0f0f0");
  for (let i = 0; i < 3; i++) {
    const sy = cupY - 1 - ((t * 3 + i) % 3);
    p(cupX + Math.round(Math.sin(t * 3 + i)), Math.floor(sy), 1, 1, "rgba(240,240,240,0.5)");
  }
  const ox = Math.round(W * 0.72), oy = 7;
  p(ox - 6, oy + 4, 14, 1, "#2a1a10");
  p(ox, oy, 4, 4, "#6a5a4a");
  p(ox, oy - 1, 1, 1, "#6a5a4a");
  p(ox + 3, oy - 1, 1, 1, "#6a5a4a");
  const blink = Math.floor(t * 1.5) % 5 === 0;
  const glow = u > 10 && u < 13;
  p(ox, oy + 1, 1, 1, blink ? "#6a5a4a" : glow ? "#ffe060" : "#e8c060");
  p(ox + 3, oy + 1, 1, 1, blink ? "#6a5a4a" : glow ? "#ffe060" : "#e8c060");
  if (glow) {
    a(0.15);
    p(ox - 3, oy - 2, 10, 7, "#ffe060");
    a(1);
  }
  a(0.22);
  for (let i = 0; i < 6; i++) {
    const a = t * 0.6 + i;
    p(Math.round(W * 0.5 + Math.cos(a) * W * 0.35), Math.round(15 + Math.sin(a * 1.3) * 3), 24, 2, "#a8b8b0");
  }
  a(1);
  sign(p, W, "#0a120e", "#5a1a1a", "#e8e0d0");
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

// Leaf Chase, a nod to Animal Crossing, a game. In a sunny meadow with five
// orange trees, a villager with a round head, a blue shirt, and a red cap runs
// after a falling leaf with a net. At 7.5 s the villager catches the leaf, and
// yellow sparkles show until 9 s. Leaves fall through the strip. The loop is
// 12 s.
function leafChase(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 12;
  p(0, 0, W, 14, "#a8d8f0");
  p(0, 14, W, 10, "#8ac060");
  p(0, 14, W, 1, "#a8d878");
  for (let i = 0; i < 5; i++) broadTree(p, Math.round(W * (0.08 + i * 0.22)), 3 + (i % 2), 4, ["#f08a3a", "#f0b040", "#e05a2a"], "#8a5a3a");
  for (let i = 0; i < 18; i++) p(Math.floor(rnd(i + 20) * W), 19 + Math.floor(rnd(i + 21) * 4), 2, 1, LEAF[i % 5]);
  const lx = Math.round(W * 0.5 + Math.sin(u * 1.8) * W * 0.2 + (u / 12) * W * 0.1), ly = Math.min(15, Math.round(3 + u * 1.6));
  const caught = u > 7.5;
  if (!caught) {
    p(lx, ly, 2, 2, "#e05a2a");
    p(lx + 1, ly - 1, 1, 1, "#e05a2a");
  }
  const vx = Math.round(caught ? W * 0.5 + 4 : lx - 6 + Math.sin(t * 3) * 1), vy = 18;
  disc(p, vx + 2, vy - 7, 2.5, "#f0d0a0");
  p(vx + 1, vy - 7, 1, 1, "#202020");
  p(vx + 3, vy - 7, 1, 1, "#202020");
  p(vx, vy - 10, 5, 1, "#c84a2a");
  p(vx, vy - 4, 5, 3, "#3a8ad8");
  p(vx + 1, vy - 1, 1, 1, "#5a3a2a");
  p(vx + 3, vy - 1, 1, 1, "#5a3a2a");
  const net = caught ? 0 : Math.round(Math.sin(t * 6) * 2);
  p(vx + 5, vy - 6 + net, 1, 5, "#8a6a3a");
  disc(p, vx + 6, vy - 8 + net, 1.6, "#e8e8e8");
  if (caught) {
    p(vx + 6, vy - 9, 2, 2, "#e05a2a");
    if (u < 9) for (let i = 0; i < 6; i++) p(vx + 4 + Math.floor(rnd(i + Math.floor(t * 8)) * 6), vy - 13 + Math.floor(rnd(i + 3) * 4), 1, 1, "#ffe060");
  }
  leaves(p, W, 5, 8, t, 2);
  sign(p, W, "#fff4e0", "#e05a2a", "#8a5a3a");
}

// The Raid, a nod to Fantastic Mr. Fox. On a farm at night, under a moon and
// stars, three farm buildings stand in a row, and a window in each lights in
// turn. Two lamp posts sweep light beams over the ground. An orange fox with a
// white bundle runs to a hole in the ground. From 9 s to 10.5 s it jumps into
// the hole, and earth flies up. The loop is 16 s.
function raid(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, H, "#0e1424");
  stars(p, W, 101, Math.floor(W / 14), 10, t);
  disc(p, Math.round(W * 0.1), 4, 2.5, "#f0ecd0");
  p(0, 17, W, 7, "#2a3a1e");
  p(0, 17, W, 1, "#3a4a24");
  const sx = [0.35, 0.58, 0.8];
  sx.forEach((f, i) => {
    const x = Math.round(W * f);
    p(x, 9, 14, 8, ["#6a2a1a", "#4a3a2a", "#5a4a3a"][i]);
    for (let k = 0; k < 3; k++) p(x - 1 + k, 8 - k, 16 - k * 2, 1, "#3a2a1a");
    p(x + 5, 13, 4, 4, "#1a1008");
    if (Math.floor(t + i) % 3 === 0) p(x + 2, 11, 2, 2, "#e8c56a");
  });
  const hx = Math.round(W * 0.2);
  disc(p, hx, 19, 3, "#1a1008", 24);
  const run = u < 9 ? u / 9 : 1;
  const fx = Math.round(W * 0.62 - run * (W * 0.62 - hx));
  const dive = u >= 9 && u < 10.5;
  if (u < 9 || dive) {
    const yy = dive ? 18 + Math.round((u - 9) * 4) : 18;
    p(fx, yy - 6, 3, 2, "#d8641e");
    p(fx - 1, yy - 7, 1, 1, "#d8641e");
    p(fx + 2, yy - 7, 1, 1, "#d8641e");
    p(fx, yy - 5, 1, 1, "#f0f0e8");
    p(fx, yy - 4, 4, 3, "#8a5a2a");
    p(fx + 4, yy - 3, 3, 1, "#d8641e");
    p(fx + 6, yy - 3, 1, 1, "#f0f0e8");
    p(fx + (Math.floor(t * 8) % 2), yy - 1, 1, 1, "#3a2010");
    p(fx + 3 - (Math.floor(t * 8) % 2), yy - 1, 1, 1, "#3a2010");
    if (u < 9) {
      p(fx - 2, yy - 4, 2, 2, "#f0f0e8");
      p(fx - 3, yy - 4, 1, 1, "#d82020");
    }
  }
  if (dive) for (let i = 0; i < 8; i++) {
    const e = u - 9;
    p(Math.round(hx + (rnd(i) - 0.5) * 10 * e * 2), Math.round(17 - rnd(i + 1) * 8 * e + e * e * 6), 1, 1, "#5a3a1a");
  }
  const sweep = Math.sin(t * 0.8);
  for (const f of [0.45, 0.85]) {
    const lx = Math.round(W * f);
    p(lx, 12, 2, 5, "#4a4a42");
    p(lx, 11, 2, 1, "#2a2a2a");
    for (let k = 0; k < 22; k++) {
      a(0.2 * (1 - k / 22));
      p(Math.round(lx - k + sweep * k * 0.6), 13 + Math.round(k * 0.2), 1, 1 + Math.floor(k / 6), "#fff3c4");
    }
    a(1);
  }
  sign(p, W, "#0e1424", "#8a5a2a", "#f0c080");
}

// The Harvest Helpers, a nod to Stardew Valley, a game. On a farm in the light
// of the evening, three rows of crops are in the soil: orange, yellow, and
// purple. Each crop disappears at its own time between 4 s and 20 s. A
// scarecrow waves its arms. Five small round helpers in different colors hop to
// a crate on the right, and each one carries a crop until it reaches the crate.
// Leaves fall through the strip. The loop is 24 s.
function harvest(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 24;
  p(0, 0, W, 12, "#f0c890");
  p(0, 12, W, 12, "#6a4a2a");
  disc(p, Math.round(W * 0.9), 6, 2.5, "#fff0c0");
  for (let x = 0; x < W; x++) {
    const h = Math.round(2 + Math.sin(x * 0.05));
    p(x, 12 - h, 1, h, "#c8803a");
  }
  for (let r = 0; r < 3; r++) for (let x = 6 + (r % 2) * 4; x < W - 30; x += 8) {
    const k = x + r * 50, taken = u > 4 + rnd(k) * 16;
    p(x, 15 + r * 3, 4, 1, "#3a6a2a");
    if (!taken) {
      p(x + 1, 14 + r * 3, 2, 2, ["#e8701a", "#d8c040", "#a83a8a"][r]);
    }
  }
  const sc = Math.round(W * 0.35);
  p(sc, 6, 1, 14, "#6a4a2a");
  const wave = Math.round(Math.sin(t * 0.9) * 1);
  p(sc - 4, 9 + wave, 9, 1, "#6a4a2a");
  p(sc - 1, 5, 3, 3, "#e8c060");
  p(sc - 2, 4, 5, 1, "#8a5a2a");
  p(sc - 2, 8, 5, 4, "#4a7ab8");
  p(sc - 5, 8 + wave, 1, 2, "#e8c060");
  p(sc + 5, 8 - wave, 1, 2, "#e8c060");
  const cx = Math.round(W - 22);
  p(cx, 15, 10, 6, "#8a5a2a");
  p(cx, 14, 10, 1, "#a8703a");
  p(cx + 4, 16, 2, 2, "#d8a020");
  const cols = ["#4ad04a", "#d84ad8", "#ffd23a", "#4aa3ff", "#ff6a3a"];
  for (let i = 0; i < 5; i++) {
    const ph = ((u * 0.12 + i * 0.2) % 1);
    const x = Math.round(10 + ph * (cx - 10)), hop = Math.abs(Math.round(Math.sin(t * 3.5 + i) * 2));
    const y = 18 - hop;
    p(x, y - 2, 3, 3, cols[i]);
    p(x, y - 1, 1, 1, "#202020");
    p(x + 2, y - 1, 1, 1, "#202020");
    p(x + 1, y - 3, 1, 1, cols[i]);
    if (ph < 0.9) p(x + 1, y - 5, 2, 2, ["#e8701a", "#d8c040", "#a83a8a"][i % 3]);
  }
  leaves(p, W, 7, 6, t * 0.6, 2);
  sign(p, W, "#f0c890", "#8a5a2a", "#5a3a1a");
}


/** LATEAUTUMN holds the late-autumn scenes, in the order of rotation. Each name is unique. */
export const LATEAUTUMN: Script[] = [
  { name: "The Thing in the Fog", period: 16, still: 10, draw: fogThing },
  { name: "The Duel in the Garden", period: 14, still: 6, draw: duel },
  { name: "Coffee and the Owl", period: 16, still: 11, draw: coffee },
  { name: "The Vineyard", period: 24, still: 13.5, draw: vineyard },
  { name: "Leaf Chase", period: 12, still: 8, draw: leafChase },
  { name: "The Raid", period: 16, still: 9.3, draw: raid },
  { name: "The Harvest Helpers", period: 24, still: 8, draw: harvest },
];

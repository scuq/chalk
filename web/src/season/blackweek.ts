// chalk-web -- 129-22: the nine Black Week scenes.
//
// Black Week, from the Monday before Black Friday to Cyber Monday, shows one
// of these scenes. Each scene is a nod to a film, a series, or a game with a
// famous moment about money or a sale. Eight scenes nod to a film or a series,
// and one nods to a game. A scene shows one moment only.
// Unlike the scripts of the other keys, a scene here can show short sign words
// and prices, because the text is the joke. A scene still has no show title,
// no logo, and no likeness of an actor. A figure is generic: it has big ears,
// or a top hat, or a cane, or it flies.
// The bar shows twice as often as the others. scene.ts runs these scripts for
// the "black-week" key, and seasons.ts sets the dates of the key.

import { rnd, sign, STRIP_H, type Alpha, type Px, type Script } from "./strip";

const H = STRIP_H;

// The font of this file: the capital letters, digits, and a few signs that the
// signs of the scenes use. Each glyph has five rows of three pixels, read row
// by row.
const FONT: Record<string, string> = {
  A: "010101111101101",
  B: "110101110101110",
  C: "011100100100011",
  D: "110101101101110",
  E: "111100110100111",
  F: "111100110100100",
  G: "011100101101011",
  H: "101101111101101",
  I: "111010010010111",
  K: "101110100110101",
  L: "100100100100111",
  M: "101111111101101",
  N: "110101101101101",
  O: "010101101101010",
  P: "110101110100100",
  R: "110101110101101",
  S: "011100010001110",
  T: "111010010010010",
  U: "101101101101111",
  W: "101101111111101",
  Y: "101101010010010",
  "0": "111101101101111",
  "1": "010110010010111",
  "2": "111001111100111",
  "3": "111001111001111",
  "4": "101101111001001",
  "5": "111100111001111",
  "6": "111100111101111",
  "7": "111001010010010",
  "8": "111101111101111",
  "9": "111101111001111",
  "%": "101001010100101",
  "-": "000000111000000",
  "+": "000010111010000",
};

// Draws s from x, y in FONT, four pixels for each character.
function text(p: Px, x: number, y: number, s: string, ink: string): void {
  [...s].forEach((ch, i) => {
    const g = FONT[ch];
    if (!g) return;
    for (let k = 0; k < 15; k++) if (g[k] === "1") p(x + i * 4 + (k % 3), y + Math.floor(k / 3), 1, 1, ink);
  });
}

// The width in pixels of s in FONT.
function textWidth(s: string): number {
  return s.length * 4 - 1;
}

// Draws s on a small plate.
function plate(p: Px, x: number, y: number, s: string, bg: string, ink: string): void {
  p(x - 1, y - 1, textWidth(s) + 2, 7, bg);
  text(p, x, y, s, ink);
}

// A small figure with big ears and its feet at by.
function bigEar(p: Px, x: number, by: number, coat: string, step: number): void {
  const skin = "#e0a070";
  p(x, by - 8, 3, 3, skin);
  p(x - 2, by - 8, 2, 2, skin);
  p(x + 3, by - 8, 2, 2, skin);
  p(x, by - 8, 3, 1, "#c88050");
  p(x - 1, by - 5, 5, 3, coat);
  p(x + step, by - 2, 1, 2, "#2a2a2a");
  p(x + 2 - step, by - 2, 1, 2, "#2a2a2a");
}

// One bar of latinum.
function bar(p: Px, x: number, y: number): void {
  p(x, y, 3, 1, "#ffd23a");
  p(x, y + 1, 3, 1, "#c8901a");
}

// A nod to Star Trek: Deep Space Nine: the bar. A plate shows DISCOUNT 0%, and
// it changes to DISCOUNT 50% for a short time in each loop. A second plate
// shows PROFIT 200%. In each loop a banner with BLACK FRIDAY unfolds at the top
// and covers that plate for a short time.
function quarksBar(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 20;
  p(0, 0, W, H, "#1a1218");
  for (let x = 0; x < W; x += 10) p(x, 0, 1, 18, "#2a1e26");
  p(0, 17, W, 7, "#3a2a22");
  p(0, 17, W, 1, "#ffb03a");
  p(0, 18, W, 1, "#5a3a2a");
  const n = 6 + Math.floor((u / 20) * 12);
  for (let i = 0; i < n; i++) bar(p, 6 + (i % 5) * 3 + (Math.floor(Math.sqrt(i * 2)) % 2), 15 - Math.floor(i / 5) * 2);
  bigEar(p, 24, 17, "#6a3a8a", 0);
  p(27, 12, 2, 1, "#e0a070");
  const dx = Math.round(W * 0.8);
  const dy = 9;
  const r = 7;
  const rot = t * 2.4;
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      const d = Math.hypot(x, y);
      if (d > r) continue;
      const g = (Math.atan2(y, x) + rot + Math.PI * 8) % (Math.PI * 2);
      p(dx + x, dy + y, 1, 1, d < 2 ? "#ffd23a" : ["#c83030", "#2a2a2a", "#ffd23a", "#2a2a2a"][Math.floor(g / (Math.PI / 4)) % 4]);
    }
  }
  p(dx - 1, dy + r + 1, 3, 7, "#5a3a2a");
  const mx = Math.round(W * 0.6);
  p(mx, 11, 4, 3, "#8a8a92");
  p(mx - 1, 14, 6, 3, "#5a4a3a");
  p(mx + 4, 15, 2, 1, "#8a8a92");
  const swapped = u > 11 && u < 14;
  plate(p, Math.round(W * 0.3), 12, swapped ? "DISCOUNT 50%" : "DISCOUNT 0%", "#101010", swapped ? "#ff6a4a" : "#7dff8a");
  const bx = mx + 9;
  if (u > 4 && u < 8) {
    const e = Math.min(1, (u - 4) / 0.6);
    p(bx - 1, 1, 50, Math.round(e * 7), "#101010");
    if (e >= 1) text(p, bx, 2, "BLACK FRIDAY", "#ff4a4a");
  } else {
    plate(p, bx, 2, "PROFIT 200%", "#101010", "#ffd23a");
  }
  const romX = u < 10 ? -10 : u < 12 ? Math.round(-10 + ((u - 10) / 2) * (W * 0.3 + 10)) : u < 16 ? Math.round(W * 0.3 + ((u - 12) / 4) * W * 0.7) : W + 20;
  if (romX > -8 && romX < W + 8) bigEar(p, romX, 21, "#3a5a3a", Math.floor(t * 6) % 2);
  if (u > 13 && u < 17) bigEar(p, Math.round(W * 0.3 + ((u - 13) / 4) * W * 0.7) - 8, 21, "#6a3a8a", Math.floor(t * 6 + 1) % 2);
  sign(p, W, "#1a1218", "#ffb03a", "#ffd23a");
}

// A nod to Star Trek: Deep Space Nine: the pile of latinum.
function mountain(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, H, "#120e16");
  for (let x = 0; x < W; x += 12) p(x, 0, 1, 20, "#1e1824");
  p(0, 20, W, 4, "#3a2a22");
  p(0, 20, W, 1, "#6a4a32");
  const cx = Math.round(W * 0.66);
  const level = u < 10 ? Math.floor(u * 1.4) : 14;
  const collapse = u >= 10 ? Math.min(1, (u - 10) / 1.2) : 0;
  for (let l = 0; l < level; l++) {
    const w = Math.max(1, 7 - Math.floor(l / 2));
    for (let i = 0; i < w; i++) {
      const bx = cx - w * 2 + i * 4 + (l % 2) * 2;
      const by = 18 - l * 2 + Math.floor(l / 3);
      const k = l * 10 + i;
      bar(p, Math.round(bx + collapse * (rnd(k) - 0.5) * 40), Math.min(19, Math.round(by + collapse * (19 - by) * rnd(k + 1))));
    }
  }
  if (u >= 10 && u < 11) {
    for (let i = 0; i < 10; i++) p(cx - 10 + Math.floor(rnd(i + Math.floor(t * 12)) * 20), 4 + Math.floor(rnd(i + 5) * 12), 1, 1, "#fff0a0");
  }
  const qx = u < 10 ? cx - 18 : Math.round(cx - 18 - (u - 10) * 3);
  bigEar(p, qx, 20, "#6a3a8a", u < 10 ? 0 : Math.floor(t * 6) % 2);
  if (u < 10) {
    bar(p, qx + 4, 12 - (Math.floor(t * 2) % 2));
  } else {
    p(qx - 2, 11, 1, 3, "#e0a070");
    p(qx + 5, 11, 1, 3, "#e0a070");
  }
  sign(p, W, "#120e16", "#ffb03a", "#ffd23a");
}

// A nod to South Park.
function stampede(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 14;
  p(0, 0, W, H, "#1a2232");
  p(0, 18, W, 6, "#3a3a40");
  p(0, 18, W, 1, "#6a6a72");
  const mx = Math.round(W * 0.6);
  const mw = Math.round(W * 0.36);
  p(mx, 4, mw, 14, "#5a5a68");
  p(mx, 4, mw, 1, "#8a8a98");
  plate(p, mx + Math.round(mw / 2) - 7, 6, "SALE", "#c82020", "#ffffff");
  const open = u >= 5;
  const dx = mx + Math.round(mw / 2) - 6;
  const gap = open ? Math.min(6, Math.round((u - 5) * 12)) : 0;
  p(dx - gap, 12, 6, 6, "#8ad0ff");
  p(dx + 6 + gap, 12, 6, 6, "#8ad0ff");
  if (open) p(dx + 6 - gap, 12, gap * 2, 6, "#ffe8a0");
  const colors = ["#c83030", "#3a6ea8", "#40a060", "#d8a020", "#a040a0", "#e07030"];
  for (let i = 0; i < 16; i++) {
    const base = 4 + ((i * 5) % Math.max(1, Math.round(W * 0.5)));
    const run = open ? Math.min(1, (u - 5 - (i % 5) * 0.2) / 2.5) : 0;
    if (run >= 1) continue;
    const x = Math.round(base + Math.max(0, run) * (dx + 6 - base));
    const y = 18 - (open ? Math.floor(t * 8 + i) % 2 : 0);
    p(x, y - 5, 3, 3, "#f0c8a0");
    p(x, y - 6, 3, 1, colors[(i + 2) % 6]);
    p(x, y - 2, 3, 2, colors[i % 6]);
    if (!open && i % 4 === 0) p(x + 3, y - 4, 1, 1, "#ffffff");
  }
  if (open && u < 9) {
    for (let i = 0; i < 12; i++) {
      const k = i + Math.floor(t * 10) * 12;
      p(Math.floor(rnd(k) * dx), 15 + Math.floor(rnd(k + 1) * 3), 2, 1, "#8a8a80");
    }
  }
  sign(p, W, "#1a2232", "#c82020", "#ffffff");
}

// A nod to DuckTales.
function moneyBin(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 14;
  p(0, 0, W, H, "#2a3a4a");
  p(0, 0, W, 2, "#4a5a6a");
  const top = 13;
  for (let x = 0; x < W; x++) {
    const h = Math.round(Math.sin(x * 0.2 + 1));
    p(x, top + h, 1, H - top - h, "#d8a020");
    if ((x + Math.floor(t * 2)) % 7 === 0) p(x, top + h, 1, 1, "#fff0a0");
  }
  for (let i = 0; i < 30; i++) p(Math.floor(rnd(i) * W), top + 2 + Math.floor(rnd(i + 3) * 8), 1, 1, "#a87810");
  const bx = Math.round(W * 0.12);
  p(bx, 8, 18, 1, "#8a6a4a");
  p(bx, 9, 1, 4, "#8a6a4a");
  let dx: number;
  let dy: number;
  let inPile = false;
  if (u < 3) {
    dx = bx + 2 + Math.round(u * 4);
    dy = 2;
  } else if (u < 4.2) {
    const e = (u - 3) / 1.2;
    dx = bx + 14 + Math.round(e * 20);
    dy = Math.round(2 - Math.sin(e * Math.PI) * 4 + e * 12);
  } else if (u < 9) {
    inPile = true;
    dx = bx + 34 + Math.round((u - 4.2) * 8);
    dy = top - 1;
  } else {
    dx = bx + 72;
    dy = Math.round(top - 1 - Math.min(1, (u - 9) / 2));
  }
  if (inPile) {
    const sw = Math.floor(t * 4) % 2;
    p(dx, dy - 1 + sw, 3, 2, "#ffffff");
    p(dx + 3, dy + sw, 1, 1, "#ffb030");
    p(dx - 1, dy - 3 + sw, 3, 2, "#202020");
    for (let i = 0; i < 4; i++) {
      const k = i + Math.floor(t * 8) * 4;
      p(dx - 4 + Math.floor(rnd(k) * 10), dy - 1 - Math.floor(rnd(k + 1) * 4), 1, 1, "#ffd23a");
    }
  } else {
    p(dx, dy, 4, 3, "#ffffff");
    p(dx + 4, dy + 1, 2, 1, "#ffb030");
    p(dx + 2, dy, 1, 1, "#202020");
    p(dx - 1, dy - 2, 4, 2, "#202020");
    p(dx - 1, dy + 3, 5, 3, "#3a6ab8");
    p(dx, dy + 6, 1, 1, "#ffb030");
    p(dx + 3, dy + 6, 1, 1, "#ffb030");
  }
  if (u >= 4.2 && u < 4.8) {
    const e = u - 4.2;
    for (let i = 0; i < 16; i++) p(Math.round(bx + 34 + (rnd(i) - 0.5) * 14), Math.round(top - rnd(i + 1) * 20 * e + e * e * 20), 1, 1, "#ffd23a");
  }
  sign(p, W, "#2a3a4a", "#d8a020", "#fff0a0");
}

// A nod to Spaceballs.
function merch(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 14;
  p(0, 0, W, H, "#1a1a2a");
  p(0, 19, W, 5, "#3a3020");
  p(0, 19, W, 1, "#5a4830");
  const yx = Math.round(W * 0.45);
  p(yx, 13, 4, 3, "#c8b060");
  p(yx - 2, 13, 2, 1, "#c8b060");
  p(yx + 4, 13, 2, 1, "#c8b060");
  p(yx + 1, 14, 1, 1, "#202020");
  p(yx - 1, 16, 6, 3, "#8a6a4a");
  p(yx + 6, 12, 1, 7, "#6a4a2a");
  const items = ["#c83030", "#3a6ea8", "#d8a020", "#40a060", "#a040a0", "#e8e8e8", "#e07030", "#4ad0d0"];
  const n = Math.min(30, Math.floor(u * 3));
  for (let i = 0; i < n; i++) {
    const side = i % 2 ? 1 : -1;
    const lvl = Math.floor(i / 6);
    const col = Math.floor(i / 2) % 3;
    const y = 16 - lvl * 3;
    if (lvl > 2) {
      p(yx - 4 + col * 4 + (i % 2) * 2, y, 4, 3, items[i % 8]);
      continue;
    }
    const x = yx + 2 + side * (5 + col * 4) - (side < 0 ? 3 : 0);
    p(x, y, 3, 3, items[i % 8]);
    p(x + 1, y + 1, 1, 1, "#ffffff");
  }
  plate(p, Math.round(W * 0.72), 12, u < 4 ? "MERCH" : `MERCH ${Math.floor(u * 7)}%`, "#101010", "#ffd23a");
  sign(p, W, "#1a1a2a", "#8a6a3a", "#ffd23a");
}

// A nod to They Live.
function glasses(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 14;
  const on = u >= 6 && u < 12;
  const tone = (color: string, gray: string) => (on ? gray : color);
  p(0, 0, W, H, tone("#1a2a4a", "#101010"));
  p(0, 19, W, 5, tone("#3a3a40", "#2a2a2a"));
  const boards: [number, string, string, string][] = [
    [0.08, "SALE", "OBEY", "#c83030"],
    [0.32, "NEW", "BUY", "#40a060"],
    [0.62, "50%", "CONSUME", "#d8a020"],
  ];
  for (const [f, before, after, color] of boards) {
    const x = Math.round(W * f);
    const w = Math.max(textWidth(before), textWidth(after)) + 6;
    p(x, 4, w, 9, tone(color, "#e8e8e8"));
    p(x + Math.round(w / 2), 13, 1, 6, tone("#6a6a72", "#5a5a5a"));
    text(p, x + 3, 6, on ? after : before, on ? "#101010" : "#ffffff");
  }
  const fx = Math.round(W * 0.5);
  p(fx, 11, 2, 2, tone("#c8a080", "#b0b0b0"));
  p(fx, 10, 2, 1, tone("#e0c070", "#c0c0c0"));
  p(fx - 1, 13, 4, 4, tone("#7a6a5a", "#606060"));
  p(fx, 17, 1, 2, "#202020");
  p(fx + 2, 17, 1, 2, "#202020");
  if (u > 5) p(fx, 11, 2, 1, "#000000");
  else p(fx + 3, 16 - (u > 4 ? Math.round((u - 4) * 3) : 0), 2, 1, "#000000");
  sign(p, W, tone("#1a2a4a", "#101010"), tone("#c83030", "#e8e8e8"), tone("#ffffff", "#e8e8e8"));
}

// A nod to Star Wars: The Phantom Menace.
function junkShop(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 14;
  p(0, 0, W, H, "#c8a070");
  p(0, 0, W, 3, "#a87850");
  p(0, 19, W, 5, "#8a6040");
  p(0, 19, W, 1, "#6a4830");
  for (let i = 0; i < 14; i++) {
    p(Math.floor(rnd(i) * W * 0.4), 13 + Math.floor(rnd(i + 2) * 5), 3 + Math.floor(rnd(i + 3) * 4), 2, ["#6a6a72", "#8a8a92", "#5a4a3a", "#9a5a3a"][i % 4]);
  }
  const wx = Math.round(W * 0.62);
  const hy = 7 + Math.round(Math.sin(t * 5));
  const wing = Math.floor(t * 12) % 2;
  p(wx, hy, 5, 5, "#5a8aa8");
  p(wx + 1, hy + 1, 1, 1, "#202020");
  p(wx + 3, hy + 1, 1, 1, "#202020");
  p(wx + 1, hy + 3, 3, 1, "#3a5a6a");
  p(wx - 2, hy - wing, 2, 2, "#8ac0d8");
  p(wx + 5, hy - wing, 2, 2, "#8ac0d8");
  const jx = Math.round(W * 0.42);
  p(jx, 11, 2, 2, "#d0a080");
  p(jx - 1, 10, 4, 1, "#7a5a3a");
  p(jx - 1, 13, 4, 6, "#a88860");
  p(jx - 2, 14, 1, 4, "#a88860");
  p(jx + 3, u >= 4 && u < 6 ? 12 + (Math.floor(t * 6) % 2) : 15, 2, 1, "#d0a080");
  const price = u < 8 ? "20" : u < 11 ? "40" : "80";
  const shake = u >= 6 && u < 8 ? Math.round(Math.sin(t * 20)) : 0;
  plate(p, wx + 8 + shake, 4, price, "#101010", u >= 8 ? "#ff6a4a" : "#7dff8a");
  sign(p, W, "#a87850", "#6a4830", "#fff0d0");
}

// A nod to Borderlands.
function markup(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 14;
  p(0, 0, W, H, "#2a2018");
  p(0, 19, W, 5, "#3a2a1a");
  p(0, 19, W, 1, "#c8902a");
  const mx = Math.round(W * 0.6);
  p(mx, 3, 22, 16, "#3a3a3a");
  p(mx + 1, 4, 20, 9, "#101820");
  for (let i = 0; i < 3; i++) {
    p(mx + 3 + i * 6, 8, 4, 2, "#8a8a92");
    p(mx + 3 + i * 6, 7, 1, 1, "#c8902a");
  }
  p(mx + 2, 14, 18, 3, "#c8902a");
  const label = u < 4 ? "-50%" : u < 6 ? (Math.floor(t * 8) % 2 ? "-50%" : "+50%") : u < 9 ? "+300%" : "+900%";
  plate(p, mx + 4, 14, label, "#101010", u < 4 ? "#7dff8a" : "#ff4a4a");
  const bx = Math.round(W * 0.3);
  p(bx, 9, 4, 4, "#d0a080");
  p(bx, 8, 4, 1, "#4a3a2a");
  p(bx - 2, 13, 8, 6, "#6a4a2a");
  p(bx + 1, 11, 2, 1, "#4a3a2a");
  if (u >= 9) {
    p(bx - 3, 11 + (Math.floor(t * 4) % 2), 1, 3, "#d0a080");
    p(bx + 6, 11 + (Math.floor(t * 4 + 1) % 2), 1, 3, "#d0a080");
  }
  const cx = Math.round(W * 0.12) + (u > 6 ? Math.round(Math.min(1, (u - 6) / 2) * -10) : 0);
  p(cx, 12, 2, 2, "#e0b090");
  p(cx - 1, 14, 4, 4, "#3a6ab8");
  p(cx, 18, 1, 1, "#202020");
  p(cx + 2, 18, 1, 1, "#202020");
  sign(p, W, "#2a2018", "#c8902a", "#ffd23a");
}

// A nod to Star Trek: Deep Space Nine: the sign.
function wrongSign(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, H, "#1a1218");
  p(0, 17, W, 7, "#3a2a22");
  p(0, 17, W, 1, "#ffb03a");
  const sx = Math.round(W * 0.3);
  p(sx - 2, 3, 38, 9, "#101010");
  text(p, sx, 5, u < 3 ? "50% OFF" : u < 4 ? "50 % OFF" : "500% OFF", u < 3 ? "#ffd23a" : "#ff4a4a");
  p(sx + 15, 12, 1, 5, "#5a3a2a");
  const romX = u < 3 ? sx + 6 : Math.round(sx + 6 + Math.min(1, u - 3) * 6);
  bigEar(p, romX, 17, "#3a5a3a", 0);
  if (u >= 2 && u < 3.5) p(romX + 4, 10, 1, 3, "#e8e8e8");
  const rush = u >= 5 ? Math.min(1, (u - 5) / 3) : 0;
  const cols = ["#c83030", "#3a6ea8", "#40a060", "#d8a020", "#a040a0"];
  for (let i = 0; i < 10; i++) {
    const x = Math.round(W + 4 + i * 6 - rush * (W * 0.55 + i * 3));
    p(x, 12, 2, 2, "#f0c8a0");
    p(x - 1, 14, 4, 3, cols[i % 5]);
    p(x + (Math.floor(t * 8 + i) % 2), 17, 1, 1, "#202020");
    if (rush > 0.8) bar(p, x - 2, 10);
  }
  const qx = Math.round(W * 0.12);
  const panic = u > 8;
  bigEar(p, qx, 17, "#6a3a8a", panic ? Math.floor(t * 8) % 2 : 0);
  if (panic) {
    p(qx - 2, 7 + (Math.floor(t * 8) % 2), 1, 3, "#e0a070");
    p(qx + 5, 7 + (Math.floor(t * 8 + 1) % 2), 1, 3, "#e0a070");
    p(qx + 6, 6, 1, 1, "#8ad0ff");
  }
  for (let i = 0; i < 6; i++) {
    const gone = u > 9 && rnd(i) < (u - 9) / 6;
    if (!gone) bar(p, qx - 4 + (i % 3) * 3, 15 - Math.floor(i / 3) * 2);
  }
  sign(p, W, "#1a1218", "#ffb03a", "#ffd23a");
}

/**
 * BLACKWEEK holds the Black Week scenes, in the order of rotation. Each name is
 * unique. The bar has weight 2, so a visit picks it twice as often as each
 * other scene.
 */
export const BLACKWEEK: Script[] = [
  { name: "The Bar", period: 20, still: 5.5, weight: 2, draw: quarksBar },
  { name: "The Latinum Mountain", period: 16, still: 9, draw: mountain },
  { name: "The Doors Open", period: 14, still: 6, draw: stampede },
  { name: "The Money Bin", period: 14, still: 6, draw: moneyBin },
  { name: "Merchandising", period: 14, still: 9, draw: merch },
  { name: "Through the Glasses", period: 14, still: 8, draw: glasses },
  { name: "The Junk Shop", period: 14, still: 9, draw: junkShop },
  { name: "The Machine's Markup", period: 14, still: 10, draw: markup },
  { name: "The Sign Goes Wrong", period: 16, still: 7, draw: wrongSign },
];

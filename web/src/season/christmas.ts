// chalk-web -- 129-19: the seven Christmas scenes.
//
// From 1 December to 26 December, the "christmas" key shows one of these
// scenes. In the always-on hours of Christmas Eve, from 20:00 to 05:00, the
// scene rotates through all seven. Each scene is a nod to a film or a series
// episode, and a person knows it by one famous moment. A scene has no title,
// no logo, no lettering, and no likeness of an actor. The only text is the
// CHALK sign. A scene is a Script (strip.ts). scene.ts runs these scripts in
// place of rows for the "christmas" key.

import { disc, rnd, sign, stars, STRIP_H, type Alpha, type Px, type Script } from "./strip";

const H = STRIP_H;

// Draws n snowflakes of one color. Each flake falls through the whole strip.
function snow(p: Px, W: number, seed: number, n: number, t: number, color: string): void {
  for (let i = 0; i < n; i++) {
    const k = i * 9 + seed;
    p(Math.floor(rnd(k) * W), Math.floor((t * (2 + rnd(k + 1) * 3) + rnd(k + 2) * H) % H), 1, 1, color);
  }
}

// Draws a Christmas tree with its top at y and centered on x. It has layers
// layers of two rows, and spread sets how fast each layer widens.
function tree(p: Px, x: number, y: number, layers: number, spread: number): void {
  for (let k = 0; k < layers; k++) {
    const half = 1 + Math.round(k * spread);
    p(x - half, y + k * 2, half * 2 + 1, 2, k % 2 ? "#1e6a34" : "#2a8a44");
  }
}

// A nod to Die Hard.
function tower(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, H, "#05070d");
  stars(p, W, 21, Math.floor(W / 14), 12, t);
  for (let x = 0; x < W; x++) {
    const h = 3 + Math.floor(rnd(Math.floor(x / 8) + 5) * 5);
    p(x, 20 - h, 1, h, "#0c1220");
  }
  const tx = Math.round(W * 0.62);
  p(tx - 9, 3, 18, 17, "#26303c");
  p(tx - 6, 1, 12, 2, "#26303c");
  p(tx - 5, 0, 1, 1, "#ff3030");
  p(tx + 4, 0, 1, 1, Math.floor(t * 2) % 2 ? "#ff3030" : "#601010");
  for (let y = 4; y < 19; y += 2) {
    for (let x = tx - 8; x < tx + 8; x += 2) p(x, y, 1, 1, rnd(x * 3 + y) > 0.4 ? "#e8c56a" : "#141a22");
  }
  const blasts: [number, number, number][] = [
    [4, tx + 3, 5],
    [9.5, tx - 5, 9],
    [13, tx + 5, 13],
  ];
  for (const [s0, ex, ey] of blasts) {
    const e = u - s0;
    if (e < 0 || e > 2.5) continue;
    const r = Math.min(4, e * 10);
    a(Math.max(0, 1 - e / 2.5));
    disc(p, ex, ey, r, e < 0.3 ? "#fff6c0" : "#ff9a2a");
    disc(p, ex, ey, r * 0.5, "#ffe08a");
    for (let i = 0; i < 10; i++) {
      const k = i * 7 + s0 * 11;
      p(
        Math.round(ex + (rnd(k) - 0.3) * 16 * e),
        Math.round(ey + e * e * 6 * rnd(k + 1) + (rnd(k + 2) - 0.5) * 4 * e),
        1,
        1,
        "#bfe6ff",
      );
    }
    a(1);
  }
  p(0, 20, W, 4, "#0a0e12");
  p(0, 20, W, 1, "#1c2a24");
  const blink = Math.floor(t * 6) % 2;
  [Math.round(W * 0.2), Math.round(W * 0.38)].forEach((cx, ph) => {
    p(cx, 18, 14, 2, "#d8dce0");
    p(cx + 3, 16, 7, 2, "#d8dce0");
    p(cx + 4, 17, 5, 1, "#1a2430");
    p(cx + 1, 20, 3, 2, "#0a0a0a");
    p(cx + 10, 20, 3, 2, "#0a0a0a");
    const on = (blink + ph) % 2;
    p(cx + 4, 15, 2, 1, on ? "#3a6aff" : "#1a2050");
    p(cx + 7, 15, 2, 1, on ? "#601010" : "#ff3030");
    a(0.22);
    p(cx - 4, 12, 12, 8, on ? "#3a6aff" : "#ff3030");
    a(1);
  });
  for (let i = 0; i < 2; i++) {
    const bx = Math.round(W * 0.29) + i * 9;
    p(bx, 19, 6, 1, "#e8c53a");
    p(bx + 1, 19, 1, 1, "#111111");
    p(bx + 4, 19, 1, 1, "#111111");
    p(bx, 20, 1, 1, "#5a4020");
    p(bx + 5, 20, 1, 1, "#5a4020");
  }
  const hx = Math.round(W * 0.95 - ((u * 9) % (W * 0.5)));
  p(hx, 3, 9, 2, "#6a7078");
  p(hx - 4, 4, 4, 1, "#6a7078");
  p(hx - 2, 2, 12, 1, "#9aa0a8");
  p(hx + 9, 4, 1, 1, Math.floor(t * 4) % 2 ? "#ff3030" : "#401010");
  const sw = Math.sin(t * 0.9) * 6;
  a(0.12);
  for (let y = 6; y < 20; y++) {
    p(hx + 3 + Math.round((sw * (y - 6)) / 14) - Math.floor((y - 6) / 3), y, 2 + Math.floor((y - 6) / 2), 1, "#fff2a0");
  }
  a(1);
  for (const f of [0.88, 0.94]) {
    const px = Math.round(W * f);
    p(px, 12, 1, 8, "#3a2a1a");
    p(px - 3, 11, 3, 1, "#1f6a3a");
    p(px + 1, 11, 3, 1, "#1f6a3a");
    p(px - 2, 12, 1, 1, "#1f6a3a");
    p(px + 2, 12, 1, 1, "#1f6a3a");
  }
  sign(p, W, "#081008", "#2f7a4a", "#8fe0a8");
}

// A nod to Home Alone.
function traps(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, H, "#06120c");
  stars(p, W, 31, Math.floor(W / 16), 10, t);
  snow(p, W, 0, 12, t, "#d8e8e0");
  p(0, 21, W, 3, "#0d2a1a");
  p(0, 20, W, 1, "#c8d8d0");
  const vx = Math.round(W * 0.04);
  p(vx, 15, 18, 5, "#3a4a40");
  p(vx + 13, 13, 5, 2, "#3a4a40");
  p(vx + 14, 13, 3, 1, "#1a2430");
  p(vx + 2, 20, 3, 1, "#0a0a0a");
  p(vx + 13, 20, 3, 1, "#0a0a0a");
  const hx = Math.round(W * 0.66);
  p(hx, 9, 34, 11, "#6a3a24");
  for (let k = 0; k < 4; k++) p(hx - 2 + k, 8 - k, 38 - k * 2, 1, "#8a9090");
  p(hx + 6, 2, 3, 3, "#6a3a24");
  p(hx + 25, 2, 3, 3, "#6a3a24");
  for (let r = 0; r < 2; r++) {
    for (let c = 0; c < 6; c++) {
      if (r === 1 && (c === 2 || c === 3)) continue;
      p(hx + 2 + c * 5, 10 + r * 5, 3, 3, "#f2c66b");
    }
  }
  p(hx + 15, 15, 4, 5, "#3a2418");
  p(hx + 16, 16, 2, 1, "#2f7a3a");
  p(hx + 27, 10, 3, 3, "#f2c66b");
  p(hx + 28, 11, 1, 1, "#e8c050");
  p(hx + 28, 12, 1, 1, "#d0a080");
  for (let i = 0; i < W; i += 3) if (i < hx - 2 || i > hx + 34) p(i, 20, 1, 1, rnd(i) > 0.5 ? "#ff4040" : "#40e070");
  for (let x = hx - 1; x < hx + 35; x += 3) {
    p(x, 8, 1, 1, ["#ff4040", "#40e070", "#ffd23a", "#4aa3ff"][(x + Math.floor(t * 3)) % 4]);
  }
  const nx = Math.round(W * 0.34);
  const postX = Math.round(W * 0.5);
  for (let i = 0; i < 4; i++) p(nx + i * 2, 19, 1, 1, "#c0c4c8");
  p(postX, 11, 1, 9, "#6a4a2a");
  p(postX - 7, 11, 8, 1, "#6a4a2a");
  const swingStart = 7.2;
  const sw = u < swingStart ? 0 : u < 7.9 ? (u - swingStart) / 0.7 : Math.max(0, 1 - (u - 7.9) / 2);
  const ang = -sw * 1.2 * Math.cos((u - swingStart) * 2);
  for (let k = 1; k < 6; k++) p(postX - 7 + Math.round(Math.sin(ang) * k), 11 + Math.round(Math.cos(ang) * k), 1, 1, "#9aa0a8");
  p(postX - 8 + Math.round(Math.sin(ang) * 6), 11 + Math.round(Math.cos(ang) * 6), 3, 3, "#c8ccd0");
  const walker = (x: number, by: number, coat: string, tall: boolean, down: boolean, step: number) => {
    if (down) {
      p(x - 4, by - 2, 8, 2, coat);
      p(x - 6, by - 2, 2, 2, "#d0a080");
      return;
    }
    const top = by - (tall ? 9 : 7);
    const leg = tall ? 3 : 2;
    p(x, top, 2, 2, "#d0a080");
    p(x - 1, top - 1, 4, 1, "#2a2a2a");
    p(x - 1, top + 2, 4, tall ? 4 : 3, coat);
    p(x + step, by - leg, 1, leg, "#2a2a30");
    p(x + 2 - step, by - leg, 1, leg, "#2a2a30");
  };
  const ax = Math.round(-6 + Math.min(u, 11) * W * 0.05);
  const jump = ax > nx - 4 && ax < nx + 10 ? Math.round(Math.sin(((ax - nx + 4) / 14) * Math.PI) * 4) : 0;
  if (u < 13) walker(ax, 20 - jump, "#5a5e66", false, false, Math.floor(t * 6) % 2);
  const bx = Math.round(-18 + Math.min(u, 7.7) * W * 0.06);
  const step = Math.floor(t * 6 + 1) % 2;
  if (u < 7.7) walker(bx, 20, "#6a4a30", true, false, step);
  else if (u < 11) walker(bx - 2, 20, "#6a4a30", true, true, 0);
  else if (u < 14) walker(bx, 20, "#6a4a30", true, false, step);
  if (u >= 7.7 && u < 8.4) {
    p(bx + 2, 9, 1, 1, "#ffffff");
    p(bx - 2, 10, 1, 1, "#ffd23a");
    p(bx + 4, 11, 1, 1, "#ffffff");
  }
  const sm = Math.round(W * 0.93);
  disc(p, sm, 17, 2.5, "#e8eef0");
  disc(p, sm, 13, 1.8, "#e8eef0");
  p(sm - 1, 10, 3, 1, "#1a1a1a");
  p(sm, 13, 1, 1, "#ff8a1e");
  sign(p, W, "#081a10", "#2f7a4a", "#c8e8d0");
}

// Draws one small green creature with its top-left at x, y.
function creature(p: Px, x: number, y: number, flip: boolean): void {
  p(x, y, 3, 2, "#4a7a2a");
  p(x - 1, y, 1, 1, "#4a7a2a");
  p(x + 3, y, 1, 1, "#4a7a2a");
  p(x + (flip ? 0 : 2), y + 1, 1, 1, "#ff3030");
  p(x, y + 2, 3, 2, "#3a6a22");
  p(x, y + 4, 1, 1, "#3a6a22");
  p(x + 2, y + 4, 1, 1, "#3a6a22");
}

// A nod to Gremlins.
function gremlins(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 14;
  p(0, 0, W, H, "#050b08");
  snow(p, W, 3, 16, t, "#a8c8b8");
  p(0, 20, W, 4, "#0d2418");
  p(0, 20, W, 1, "#c8d8d0");
  p(0, 12, 12, 8, "#14281c");
  p(0, 11, 13, 1, "#d8e8e0");
  p(3, 14, 3, 3, "#f2c66b");
  p(7, 14, 3, 3, "#f2c66b");
  p(W - 12, 12, 12, 8, "#14281c");
  p(W - 13, 11, 13, 1, "#d8e8e0");
  p(W - 9, 14, 3, 3, "#f2c66b");
  for (let x = 14; x < 30; x += 3) p(x, 16, 1, 4, "#1d3a28");
  p(14, 17, 16, 1, "#1d3a28");
  const tx = Math.round(W * 0.66);
  tree(p, tx, 4, 8, 1.1);
  p(tx - 1, 20, 2, 1, "#4a2a1a");
  const shake = u > 8 && u < 11 ? Math.round(Math.sin(t * 20)) : 0;
  p(tx - 1 + shake, 2, 3, 1, "#ffd23a");
  p(tx + shake, 1, 1, 3, "#ffd23a");
  for (let i = 0; i < 12; i++) {
    const on = u > 9 ? rnd(i + Math.floor(t * 10)) > 0.5 : (i + Math.floor(t * 2)) % 3 !== 0;
    const lx = tx + Math.round((rnd(i * 5) - 0.5) * (4 + i * 1.3));
    p(lx, 5 + Math.floor(i * 1.2), 1, 1, on ? ["#ff4040", "#ffd23a", "#4aa3ff"][i % 3] : "#1a3a24");
  }
  const mx = Math.round(W * 0.14) + 20;
  p(mx - 3, 14, 3, 2, "#b08060");
  p(mx + 3, 14, 3, 2, "#b08060");
  p(mx, 14, 3, 3, "#8a5a3a");
  p(mx, 17, 3, 3, "#e8dcc8");
  p(mx + 1, 15, 1, 1, "#000000");
  p(mx, 15, 1, 1, "#ffffff");
  p(mx + 6, 16, 4, 4, "#c8402a");
  p(mx + 7, 16, 1, 4, "#f0d090");
  const climb = Math.min(1, u / 7);
  creature(p, tx - 8 + Math.round(climb * 4), Math.round(15 - climb * 10), false);
  creature(p, tx + 5 - Math.round(climb * 2), Math.round(15 - climb * 6), true);
  if (u > 6 && u < 13) {
    const e = (u - 6) % 1.5;
    p(tx + 4 + Math.round(e * 6), Math.round(9 + e * e * 6), 1, 1, "#ff4040");
  }
  const gx = Math.round(W * 0.44);
  creature(p, gx, 15, Math.floor(t * 2) % 2 === 0);
  p(gx + 5, 16, 4, 4, "#c8402a");
  p(gx + 6, 16, 1, 4, "#f0d090");
  if (u > 4) {
    const e = Math.min(1, (u - 4) / 0.6);
    p(gx + 4 + Math.round(e * 3), Math.round(15 - e * 5), 5, 1, "#c8402a");
    for (let i = 0; i < 4; i++) {
      p(gx + 4 + i * 2, 19 - Math.round(e * rnd(i) * 3), 1, 1, ["#ffd23a", "#4aa3ff", "#ff4040", "#40e070"][i]);
    }
  }
  const rx = Math.round(W * 0.82 - (u % 7) * 3);
  creature(p, rx, 15, false);
  p(rx - 1, 14, 4, 1, "#d02020");
  p(rx + 3, 13, 1, 1, "#ffffff");
  p(rx - 4, 16, 3, 3, "#40a060");
  p(rx - 3, 16, 1, 3, "#ffd23a");
  sign(p, W, "#061008", "#2f7a4a", "#8fe0a8");
}

// A nod to Futurama.
function robotSanta(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 12;
  p(0, 0, W, H, "#040806");
  snow(p, W, 5, 18, t, "#c8d8d0");
  for (let x = 0; x < W; x++) {
    const seg = Math.floor(x / 6);
    const h = 4 + Math.floor(rnd(seg + 13) * 9);
    p(x, 20 - h, 1, h, seg % 3 ? "#123a24" : "#174a2c");
    if (x % 6 === 0) p(x, 20 - h, 6, 1, "#d8e8e0");
    if (x % 2 === 0 && rnd(x * 7) > 0.6) p(x, 20 - h + 2 + Math.floor(rnd(x) * (h - 3)), 1, 1, "#e8c56a");
  }
  for (const f of [0.18, 0.4]) {
    const x = Math.round(W * f);
    p(x, 2, 1, 6, "#1e6a3a");
    p(x - 1, 5, 3, 1, "#2a8a4a");
    p(x, 1, 1, 1, "#8fe0a8");
  }
  const ox = Math.round(W * 0.9);
  p(ox - 3, 8, 7, 12, "#8a2a1a");
  disc(p, ox, 7, 3, "#a83a24");
  p(ox, 2, 1, 2, "#a83a24");
  p(ox - 2, 15, 5, 1, "#f0d090");
  p(0, 20, W, 4, "#08140c");
  p(0, 20, W, 1, "#2fa060");
  const runX = Math.round(W * 0.15 + (u / 12) * W * 0.85);
  const ry = 14 - (Math.floor(runX / 30) % 2) * 2;
  p(runX, ry, 3, 3, "#9aa0a8");
  p(runX + 1, ry - 1, 1, 1, "#9aa0a8");
  p(runX, ry + 1, 3, 1, "#f0e8b0");
  p(runX + 1, ry + 1, 1, 1, "#202020");
  p(runX, ry + 3, 3, 2, "#9aa0a8");
  const st = Math.floor(t * 8) % 2;
  p(runX + st, ry + 5, 1, 2, "#9aa0a8");
  p(runX + 2 - st, ry + 5, 1, 2, "#9aa0a8");
  for (let i = 1; i < 4; i++) p(runX - i * 3, ry + 6 - (i % 2), 1, 1, "#d8e8e0");
  const sx = Math.round(runX - W * 0.3 + Math.sin(t * 1.3) * 6);
  const sy = 7 + Math.round(Math.sin(t * 2) * 1.5);
  p(sx, sy + 5, 14, 2, "#8a2a1a");
  p(sx + 1, sy + 4, 12, 1, "#a83a24");
  p(sx + 2, sy + 8, 12, 1, "#3a3a3a");
  p(sx + 13, sy + 7, 1, 1, "#3a3a3a");
  p(sx - 3 - (Math.floor(t * 12) % 2), sy + 5, 3, 2, "#ff9a2a");
  p(sx - 1, sy + 5, 1, 2, "#ffe08a");
  p(sx + 5, sy, 4, 4, "#9aa0a8");
  p(sx + 5, sy - 2, 4, 2, "#c82020");
  p(sx + 8, sy - 3, 2, 1, "#c82020");
  p(sx + 10, sy - 3, 1, 1, "#ffffff");
  p(sx + 6, sy + 1, 1, 1, "#ff2020");
  p(sx + 8, sy + 1, 1, 1, "#ff2020");
  p(sx + 5, sy + 3, 4, 1, "#f0e8b0");
  p(sx + 9, sy + 3, 6, 1, "#6a6e76");
  for (let i = 0; i < 3; i++) {
    const e = (t * 1.6 + i / 3) % 1;
    const lx = Math.round(sx + 16 + e * (runX - sx - 14));
    if (lx < runX - 2) p(lx, Math.round(sy + 3 + e * (ry - sy - 2)), 4, 1, "#ff3030");
  }
  sign(p, W, "#061008", "#2f7a4a", "#c8e8d0");
}

// A nod to Christmas Vacation.
function lightShow(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 14;
  const dark = u >= 9.2 && u < 10.8;
  p(0, 0, W, H, "#060a12");
  stars(p, W, 41, Math.floor(W / 12), 12, t);
  p(0, 20, W, 4, "#cfd8dc");
  p(0, 23, W, 1, "#9aa6aa");
  for (const x of [4, W - 22]) {
    p(x, 12, 16, 8, "#141a24");
    for (let k = 0; k < 3; k++) p(x - 1 + k, 11 - k, 18 - k * 2, 1, "#1a2230");
    p(x + 3, 14, 3, 3, dark ? "#0a0e14" : "#d0a850");
  }
  const hx = Math.round(W * 0.38);
  const hw = Math.round(W * 0.3);
  p(hx, 10, hw, 10, "#2a3040");
  for (let k = 0; k < 6; k++) p(hx - 3 + k * 2, 9 - k, hw + 6 - k * 4, 1, "#3a4252");
  const stage = u < 2 ? 0 : u < 6 ? (u - 2) / 4 : u < 9.2 ? 1 : dark ? -1 : u < 12 ? (u - 10.8) / 1.2 : 1;
  const bulbs: [number, number][] = [];
  for (let x = hx; x < hx + hw; x += 2) bulbs.push([x, 10], [x, 19]);
  for (let k = 0; k < 6; k++) bulbs.push([hx - 3 + k * 2, 9 - k], [hx + hw + 2 - k * 2, 9 - k]);
  for (let y = 10; y < 20; y += 2) bulbs.push([hx, y], [hx + hw - 1, y]);
  const colors = ["#ff4040", "#40e070", "#ffd23a", "#4aa3ff", "#ff9a3a"];
  bulbs.forEach(([x, y], i) => {
    const on = stage !== -1 && (stage >= 1 || rnd(i * 3.7) < stage);
    p(x, y, 1, 1, on ? colors[i % 5] : "#20242c");
  });
  for (let i = 0; i < 4; i++) p(hx + 4 + i * Math.round(hw / 4), 13, 3, 3, dark ? "#0a0e14" : "#e8c070");
  if (stage >= 1) {
    a(0.18 + 0.05 * Math.sin(t * 6));
    p(hx - 10, 4, hw + 20, 16, "#ffe0a0");
    a(1);
  }
  const dx = hx - 12;
  p(dx, 14, 2, 2, "#d0a080");
  p(dx - 1, 13, 4, 1, "#3a2a6a");
  p(dx - 1, 16, 4, 3, "#8a2a2a");
  p(dx, 19, 1, 1, "#2a2a30");
  p(dx + 2, 19, 1, 1, "#2a2a30");
  p(dx + 3, u < 2 ? 17 : 16, 1, 1, "#d0a080");
  for (let x = dx + 4; x < hx; x++) p(x, 19, 1, 1, "#2f6a3a");
  if (u >= 9.2 && u < 9.5) {
    a(0.5);
    p(0, 0, W, H, "#ffffff");
    a(1);
  }
  if (dark) {
    a(0.45);
    p(0, 0, W, H, "#000000");
    a(1);
  }
  sign(p, W, "#0a1020", "#2f6a4a", "#ffd23a");
}

// A nod to Star Trek: Voyager.
function ornament(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 12;
  p(0, 0, W, H, "#040a06");
  for (let i = 0; i < 6; i++) {
    const bx = Math.round((i * W) / 5 - 10);
    const by = 2 + (i % 2) * 4;
    for (let k = 0; k < 18; k++) p(bx + k * 2, by + Math.round(k * 0.35), 3, 2, (k + i) % 3 ? "#1e5a30" : "#2a7a40");
    for (let k = 0; k < 18; k += 2) p(bx + k * 2, by + 2 + Math.round(k * 0.35), 1, 2, "#143a20");
  }
  for (let i = 0; i < 26; i++) {
    const k = i * 5;
    const on = (i + Math.floor(t * 3)) % 4 !== 0;
    p(Math.floor(rnd(k) * W), 1 + Math.floor(rnd(k + 1) * 18), 1, 1, on ? ["#ffd23a", "#ff6a6a", "#8ad0ff"][i % 3] : "#2a3a20");
  }
  const after = u >= 6;
  [0.12, 0.3, 0.75, 0.9].forEach((f, i) => {
    const x = Math.round(W * f);
    const len = 5 + (i % 2) * 3;
    p(x, 6, 1, len, "#c8b070");
    const color = after ? ["#8ad0ff", "#ffd23a", "#b080ff", "#40e070"][i] : ["#c83030", "#d0a030", "#3060c0", "#c83030"][i];
    disc(p, x, 8 + len, 2, color);
    p(x - 1, 7 + len, 1, 1, "#ffffff");
  });
  const cx = Math.round(W * 0.52);
  const top = 5;
  const len = 8;
  const ang = Math.sin(t * 1.6) * 0.35;
  for (let k = 0; k < len; k++) p(cx + Math.round(Math.sin(ang) * k), top + k, 1, 1, "#c8b070");
  const sx = cx + Math.round(Math.sin(ang) * len);
  const sy = top + len;
  p(sx - 6, sy + 1, 12, 2, "#b8bec8");
  p(sx - 5, sy, 6, 1, "#d8dce4");
  p(sx + 2, sy + 1, 4, 1, "#9aa0ab");
  p(sx - 8, sy + 3, 5, 1, "#8f96a2");
  p(sx - 8, sy - 1, 5, 1, "#8f96a2");
  p(sx - 9, sy + 3, 1, 1, "#ff5a3a");
  p(sx - 9, sy - 1, 1, 1, "#ff5a3a");
  p(sx - 4, sy + 2, 1, 1, "#4aa3ff");
  if (u >= 5.6 && u < 6.6) {
    const e = u - 5.6;
    a(Math.max(0, 1 - e));
    p(0, 0, W, H, "#ffffff");
    a(Math.max(0, 1 - e) * 0.9);
    for (let i = 0; i < 16; i++) {
      const g = rnd(i) * Math.PI * 2;
      p(Math.round(sx + Math.cos(g) * e * 18), Math.round(sy + Math.sin(g) * e * 8), 1, 1, "#ffe8a0");
    }
    a(1);
  }
  sign(p, W, "#061008", "#2f7a4a", "#e8f0e0");
}

// A nod to Star Trek: Generations.
function ribbon(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, H, "#0a120c");
  p(0, 20, W, 4, "#2a1a10");
  p(0, 20, W, 1, "#3a2818");
  const wx = Math.round(W * 0.06);
  const ww = Math.round(W * 0.2);
  p(wx - 2, 3, 2, 16, "#6a2020");
  p(wx + ww, 3, 2, 16, "#6a2020");
  p(wx, 4, ww, 13, "#0a1428");
  for (let i = 0; i < 10; i++) {
    const k = i * 3;
    p(wx + Math.floor(rnd(k) * ww), 4 + Math.floor((t * 3 + rnd(k + 1) * 13) % 13), 1, 1, "#d8e8f0");
  }
  for (let x = 0; x < ww; x++) {
    const y = Math.round(9 + Math.sin(x * 0.2 + t * 1.5) * 2.5);
    p(wx + x, y, 1, 1, "#ff9a4a");
    p(wx + x, y + 1, 1, 1, "#b04ad8");
    if ((x + Math.floor(t * 8)) % 7 === 0) p(wx + x, y - 1, 1, 1, "#ffe0a0");
  }
  p(wx, 15, ww, 2, "#c8d8d0");
  p(wx + Math.round(ww / 2), 4, 1, 13, "#3a2a20");
  p(wx, 10, ww, 1, "#3a2a20");
  const ax = Math.round(W * 0.33);
  p(ax, 13, 8, 7, "#6a2a2a");
  p(ax - 1, 12, 3, 8, "#7a3434");
  const fx = Math.round(W * 0.58);
  p(fx - 2, 8, 22, 2, "#4a2e1c");
  p(fx, 10, 18, 10, "#3a2416");
  p(fx + 4, 13, 10, 7, "#120806");
  for (let i = 0; i < 8; i++) {
    const h = 1 + Math.floor(rnd(i + Math.floor(t * 10) * 3) * 4);
    p(fx + 5 + i, 20 - h, 1, h, i % 2 ? "#ffb03a" : "#ff6a1e");
  }
  for (const cx of [fx + 2, fx + 15]) {
    p(cx, 6, 1, 2, "#e8e0c0");
    p(cx, 5, 1, 1, "#ffd23a");
  }
  disc(p, fx + 9, 4, 2.5, "#2a6a3a");
  p(fx + 9, 6, 1, 1, "#c83030");
  const tx = Math.round(W * 0.78);
  tree(p, tx, 4, 8, 0.9);
  p(tx, 3, 1, 1, "#ffd23a");
  for (let i = 0; i < 10; i++) {
    const on = (i + Math.floor(t * 3)) % 3 !== 0;
    p(tx + Math.round((rnd(i * 4) - 0.5) * (2 + i * 1.3)), 5 + Math.floor(i * 1.3), 1, 1, on ? ["#ff4040", "#ffd23a", "#4aa3ff"][i % 3] : "#1a3a24");
  }
  p(tx - 6, 18, 4, 2, "#c83030");
  p(tx - 5, 18, 1, 2, "#f0d090");
  p(tx + 3, 18, 3, 2, "#3a8a4a");
  const walk = u < 3 ? 0 : Math.min(1, (u - 3) / 6);
  const px = Math.round(ax + 6 + walk * (tx - ax - 14));
  const sitting = u < 3;
  p(px, sitting ? 13 : 11, 2, 2, "#d8a888");
  p(px - 1, sitting ? 15 : 13, 4, 3, "#a82020");
  p(px - 1, sitting ? 15 : 13, 4, 1, "#202020");
  if (!sitting) {
    const st = walk < 1 ? Math.floor(t * 5) % 2 : 0;
    p(px + st, 16, 1, 4, "#202020");
    p(px + 2 - st, 16, 1, 4, "#202020");
  }
  if (u > 8) {
    const kx = Math.round(W - 4 - Math.min(1, (u - 8) / 3) * (W - tx - 10));
    [0, 5, 10].forEach((d, i) => {
      const x = kx + d;
      p(x, 15, 2, 2, "#d8a888");
      p(x, 15, 2, 1, ["#6a4a2a", "#e0c070", "#2a1a12"][i]);
      p(x, 17, 2, 2, ["#3a6ea8", "#c8402a", "#4a8a4a"][i]);
      p(x + (Math.floor(t * 6 + i) % 2), 19, 1, 1, "#20202a");
    });
  }
  sign(p, W, "#0a1a10", "#2f7a4a", "#e8f0e0");
}

/**
 * CHRISTMAS holds the seven scripts of the "christmas" key, in the order of
 * rotation. Each name is unique.
 */
export const CHRISTMAS: Script[] = [
  { name: "Party at the Tower", period: 16, still: 4.6, draw: tower },
  { name: "The House with the Traps", period: 16, still: 8, draw: traps },
  { name: "Gremlins in the Tree", period: 14, still: 7.5, draw: gremlins },
  { name: "Robot Santa", period: 12, still: 6, draw: robotSanta },
  { name: "The Light Show", period: 14, still: 7, draw: lightShow },
  { name: "The Ornament", period: 12, still: 7, draw: ornament },
  { name: "The Ribbon at Christmas", period: 16, still: 10, draw: ribbon },
];

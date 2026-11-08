// chalk-web -- 129-21: the eight winterfest scenes.
//
// On 2 January to 7 February, the "winterfest" key shows one of these scenes.
// In the always-on hours, the scene rotates through all eight. Each scene is a
// nod to a film or a series, and a person knows it by one famous moment in snow
// or ice. A scene has no title, no logo, no show lettering, and no likeness of
// an actor. A character is generic: a big-eared figure and a smooth-faced
// figure, two agents, and a four-legged walker. The only text is the CHALK
// sign. A scene is a Script (strip.ts). scene.ts runs these scripts in place of
// rows for the "winterfest" key.

import { disc, rnd, sign, stars, STRIP_H, type Alpha, type Px, type Script } from "./strip";

const H = STRIP_H;

// Snow that falls through the strip and drifts sideways with the wind.
function snowfall(p: Px, W: number, seed: number, n: number, t: number, wind: number, color: string): void {
  for (let i = 0; i < n; i++) {
    const k = i * 9 + seed;
    const y = (t * (3 + rnd(k + 1) * 4) + rnd(k + 2) * H) % H;
    const x = (((rnd(k) * W + t * wind * (1 + rnd(k + 3))) % W) + W) % W;
    p(Math.floor(x), Math.floor(y), wind > 20 ? 2 : 1, 1, color);
  }
}

// Snow driven sideways by a strong wind, in short streaks.
function blizzard(p: Px, W: number, seed: number, n: number, t: number, speed: number, color: string): void {
  for (let i = 0; i < n; i++) {
    const k = i * 11 + seed;
    const x = (rnd(k) * W + t * (speed + rnd(k + 1) * 30)) % W;
    p(Math.floor(x), Math.floor(rnd(k + 2) * 22), 2, 1, color);
  }
}

// A small standing person with its feet at by.
function person(p: Px, x: number, by: number, coat: string, head: string, hair: string, step: number): void {
  p(x, by - 7, 2, 2, head);
  p(x, by - 7, 2, 1, hair);
  p(x - 1, by - 5, 4, 3, coat);
  p(x + step, by - 2, 1, 2, "#202028");
  p(x + 2 - step, by - 2, 1, 2, "#202028");
}

// Draws a ring gate centered at gx, gy. The gate dials from tOpen - 5.6 s, is
// open from tOpen to tClose, and shuts at tClose, in the loop time u. t drives
// the water in the open gate. It reports whether the gate is open at u.
function ringGate(p: Px, gx: number, gy: number, u: number, tOpen: number, tClose: number, t: number): boolean {
  const R = 9;
  const r = 7;
  const open = u >= tOpen && u < tClose;
  if (open) {
    for (let y = gy - r; y <= gy + r; y++) {
      for (let x = gx - r; x <= gx + r; x++) {
        const d = Math.hypot(x - gx, y - gy);
        if (d > r) continue;
        const w = Math.sin(d * 1.6 - t * 5) + Math.sin((x - gx) * 0.9 + t * 3) * 0.5;
        p(x, y, 1, 1, w > 0.9 ? "#d8f4ff" : w > 0 ? "#5ab4ff" : "#2a6ad8");
      }
    }
  }
  for (let y = gy - R; y <= gy + R; y++) {
    for (let x = gx - R; x <= gx + R; x++) {
      const d = Math.hypot(x - gx, y - gy);
      if (d > R + 0.3 || d < r + 0.3) continue;
      p(x, y, 1, 1, d > R - 0.7 ? "#5a5e66" : "#8a8f98");
    }
  }
  const locked = u < tClose ? Math.min(7, Math.floor(Math.max(0, u - (tOpen - 5.6)) / 0.8)) : 0;
  const order = [1, 2, 3, 6, 7, 8, 0];
  for (let i = 0; i < 9; i++) {
    const g = ((-90 + i * 40) * Math.PI) / 180;
    const at = order.indexOf(i);
    const top = i === 0;
    p(
      Math.round(gx + Math.cos(g) * (R - 0.5)) - (top ? 1 : 0),
      Math.round(gy + Math.sin(g) * (R - 0.5)) - (top ? 1 : 0),
      top ? 3 : 2,
      2,
      at > -1 && at < locked ? "#ff7a1a" : "#7a4a2a",
    );
  }
  return open;
}

// A nod to Star Wars: The Empire Strikes Back. A small craft circles a
// four-legged walker on a snow field. From 5 s the craft wraps a tow cable
// around the legs of the walker, one more loop every 1.4 s, up to four loops.
// At 11 s the walker falls and snow rises.
function walker(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 18;
  p(0, 0, W, 10, "#9ab4c8");
  p(0, 10, W, 6, "#b8cad8");
  for (let x = 0; x < W; x++) {
    const h = Math.round(3 + 2 * Math.sin(x * 0.04) + Math.sin(x * 0.13));
    p(x, 15 - h, 1, h, "#d8e4ec");
    p(x, 15 - h, 1, 1, "#ffffff");
  }
  p(0, 15, W, 9, "#eef4f8");
  for (let i = 0; i < 10; i++) p(Math.floor(rnd(i + 40) * W), 17 + Math.floor(rnd(i + 41) * 6), 2, 1, "#c8d8e4");
  const fall = u < 11 ? 0 : Math.min(1, (u - 11) / 1.2);
  const wx = Math.round(W * 0.15 + Math.min(u, 11) * W * 0.03);
  if (u <= 16) {
    const bodyY = Math.round(4 + fall * 11);
    const tilt = Math.round(fall * 3);
    const legLen = Math.max(0, 16 - bodyY);
    for (let i = 0; i < 4; i++) {
      const lx = wx + 1 + i * 4;
      const phase = Math.sin(t * 1.6 + i * 1.6);
      const lift = fall ? 0 : Math.max(0, Math.round(phase * 1.5));
      const upper = Math.round(legLen / 2);
      if (legLen > 1) {
        p(lx + Math.round(phase), bodyY + 5, 2, upper, "#8a9098");
        p(lx, bodyY + 5 + upper, 2, Math.max(0, legLen - upper - lift), "#8a9098");
        p(lx - 1, 20 - lift, 4, 1, "#6a7078");
      }
    }
    p(wx, bodyY + tilt, 17, 5, "#a8aeb6");
    p(wx, bodyY + tilt, 17, 1, "#c8ced6");
    p(wx + 2, bodyY + 3 + tilt, 12, 1, "#7a8088");
    p(wx + 17, bodyY + 2 + tilt * 2, 5, 3, "#a8aeb6");
    p(wx + 21, bodyY + 3 + tilt * 2, 1, 1, "#303030");
    p(wx + 22, bodyY + 4 + tilt * 2, 2, 1, "#5a5e66");
    if (fall > 0.9 && u < 13.5) {
      const e = Math.max(0, u - 12.2);
      for (let i = 0; i < 14; i++) p(wx + Math.floor(rnd(i) * 26), Math.round(19 - rnd(i + 3) * 6 * e), 1, 1, "#ffffff");
    }
  }
  if (u < 11) {
    const g = t * 2.2;
    const sx = Math.round(wx + 8 + Math.cos(g) * 14);
    const sy = Math.round(15 + Math.sin(g) * 2);
    p(sx, sy, 4, 1, "#d8dce0");
    p(sx + (Math.cos(g + 1.57) > 0 ? 3 : -1), sy - 1, 1, 1, "#c84a3a");
    p(sx + 1, sy + 1, 2, 1, "#8a9098");
    if (u > 5) {
      const loops = Math.min(4, Math.floor((u - 5) / 1.4));
      for (let k = 0; k < loops; k++) p(wx, 13 + k, 17, 1, "#3a3a3a");
    }
  }
  snowfall(p, W, 1, 10, t, 4, "#ffffff");
  sign(p, W, "#e8f0f6", "#5a7a9a", "#3a5a7a");
}

// A nod to Stargate SG-1. A figure digs in the ice, and a second figure stands
// by a ring gate. The gate dials, opens in blue light from 9 s to 15 s, and
// shuts with a white flash.
function iceGate(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 18;
  p(0, 0, W, H, "#1a3a5a");
  for (let x = 0; x < W; x++) {
    const h = 2 + Math.floor(rnd(Math.floor(x / 3) + 7) * 4);
    p(x, 0, 1, h, "#a8d0ec");
    if (rnd(x) > 0.85) p(x, h, 1, 2, "#d8f0ff");
  }
  for (let i = 0; i < 30; i++) p(Math.floor(rnd(i + 3) * W), 4 + Math.floor(rnd(i + 9) * 14), 2, 1, "#2a5478");
  p(0, 19, W, 5, "#c8e4f4");
  p(0, 19, W, 1, "#ffffff");
  const gx = Math.round(W * 0.68);
  const gy = 12;
  const open = ringGate(p, gx, gy, u, 9, 15, t);
  p(gx - 11, 17, 23, 3, "#c8e4f4");
  if (open) {
    a(u < 9.5 ? 0.5 : 0.15);
    p(0, 0, W, H, "#5ab4ff");
    a(1);
  }
  if (u >= 15 && u < 15.4) {
    a(1 - (u - 15) / 0.4);
    disc(p, gx, gy, 7, "#bfe6ff");
    a(1);
  }
  const dx = Math.round(W * 0.3);
  const dig = Math.floor(t * 3) % 2;
  person(p, dx, 19, "#2a3a5a", "#e0b090", "#e0c070", 0);
  p(dx + 3, 14 + dig, 1, 4, "#6a4a2a");
  p(dx + 3, 18 + dig, 2, 1, "#8a9098");
  if (dig) {
    p(dx + 6, 16, 1, 1, "#ffffff");
    p(dx + 7, 15, 1, 1, "#ffffff");
  }
  for (let i = 0; i < 3; i++) p(dx + 6 + i * 2, 18 - i, 2, 1 + i, "#e8f4fc");
  const sx = gx - 15;
  p(sx, 15, 2, 2, "#d0a080");
  p(sx, 15, 2, 1, "#5a5a50");
  p(sx - 1, 17, 5, 2, "#3a4a3a");
  sign(p, W, "#0e2238", "#5a8ab0", "#d8f0ff");
}

// A nod to Star Trek: Voyager. A ship lies in a glacier. A small craft lands,
// and two figures walk toward the ship with light beams. From 10.5 s to 12 s
// the windows of the ship are lit.
function glacier(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, H, "#0e1824");
  stars(p, W, 91, Math.floor(W / 14), 8, t);
  for (let x = 0; x < W; x++) {
    const h = Math.round(9 + 2 * Math.sin(x * 0.03) + Math.sin(x * 0.11));
    p(x, 24 - h, 1, h, "#9ac0d8");
    p(x, 24 - h, 1, 1, "#d8f0ff");
  }
  const hx = Math.round(W * 0.4);
  p(hx, 11, 30, 3, "#8a929c");
  p(hx + 2, 10, 24, 1, "#a8b0ba");
  p(hx + 26, 12, 8, 3, "#7a828c");
  p(hx + 4, 14, 14, 2, "#6a727c");
  p(hx - 4, 9, 10, 2, "#8a929c");
  p(hx - 5, 9, 1, 2, "#ff5a3a");
  const lit = u >= 10.5 && u < 12;
  for (let i = 0; i < 9; i++) p(hx + 3 + i * 3, 12, 1, 1, lit ? "#ffe08a" : "#2a3038");
  a(0.55);
  p(hx - 6, 13, 44, 5, "#b8daf0");
  a(0.35);
  p(hx + 10, 9, 20, 4, "#b8daf0");
  a(1);
  const shY = u < 4 ? Math.round(-4 + u * 3.5) : 10;
  const shx = Math.round(W * 0.82);
  p(shx, shY, 7, 3, "#c8ccd4");
  p(shx + 1, shY + 3, 5, 1, "#8a929c");
  p(shx + 6, shY + 1, 1, 1, "#ff5a3a");
  if (u < 4) {
    a(0.3);
    p(shx + 1, shY + 4, 5, Math.max(0, 13 - shY), "#ffe8b0");
    a(1);
  }
  const walk = u < 4 ? 0 : Math.min(1, (u - 4) / 5);
  const ax = Math.round(shx - 6 - walk * W * 0.2);
  const sweep = Math.sin(t * 1.1);
  const pair: [number, string][] = [
    [ax, "#3a3a4a"],
    [ax + 6, "#5a3a2a"],
  ];
  pair.forEach(([x, coat], i) => {
    person(p, x, 15, coat, "#c8a080", "#1a1a1a", walk < 1 ? Math.floor(t * 5 + i) % 2 : 0);
    for (let k = 0; k < 20; k++) {
      a(0.24 * (1 - k / 20));
      p(x - 1 - k, Math.round(10 + k * (0.15 + sweep * 0.12 * (i ? -1 : 1))), 1, 1 + Math.floor(k / 6), "#fff3c4");
    }
    a(1);
  });
  a(0.15);
  for (let i = 0; i < 4; i++) p(Math.round(((t * 6 + (i * W) / 4) % (W + 40)) - 20), 15 + (i % 3), 30, 2, "#e8f4fc");
  a(1);
  snowfall(p, W, 2, 12, t, 3, "#e8f4fc");
  sign(p, W, "#0e1824", "#5a8ab0", "#d8f0ff");
}

// A nod to Star Trek: Deep Space Nine. Two figures climb a snow slope. From 7 s
// to 9.5 s one of them slips and slides down, and then they climb again.
function climb(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, H, "#8aa0b4");
  for (let x = 0; x < W; x++) {
    const h = Math.round(6 + 4 * Math.sin(x * 0.05 + 1));
    p(x, 14 - h, 1, h, "#b8c8d4");
  }
  const slope = (x: number) => Math.round(22 - (x / W) * 14);
  for (let x = 0; x < W; x++) {
    const y = slope(x);
    p(x, y, 1, H - y, "#e8eef4");
    p(x, y, 1, 1, "#ffffff");
    if (rnd(x) > 0.9) p(x, y + 1, 2, 1, "#6a7480");
  }
  const slip = u >= 7 && u < 9.5;
  const slide = slip ? Math.min(1, (u - 7) / 0.6) : 0;
  const prog = (Math.min(u, 7) / 7) * 0.25 + (u > 9.5 ? ((Math.min(u, 15) - 9.5) / 5.5) * 0.25 : 0) - slide * 0.04;
  const ox = Math.round(W * (0.3 + prog) + 10);
  const qx = slip ? Math.round(W * (0.3 + prog) - 2 - slide * 4) : ox - 10;
  const step = Math.floor(t * 4) % 2;
  const oy = slope(ox);
  p(ox, oy - 7, 2, 2, "#c8a888");
  p(ox - 1, oy - 5, 4, 4, "#8a6a4a");
  p(ox, oy - 1, 1, 1, "#2a2a2a");
  p(ox + 2, oy - 1, 1, 1, "#2a2a2a");
  const qy = slope(qx);
  if (slip && u > 7.6) {
    p(qx - 3, qy - 2, 6, 2, "#5a5a6a");
    p(qx - 5, qy - 2, 2, 2, "#e0a070");
    p(qx - 6, qy - 3, 1, 1, "#e0a070");
    p(qx - 4, qy - 3, 1, 1, "#e0a070");
  } else {
    p(qx, qy - 7, 2, 2, "#e0a070");
    p(qx - 1, qy - 7, 1, 2, "#e0a070");
    p(qx + 2, qy - 7, 1, 2, "#e0a070");
    p(qx - 1, qy - 5, 4, 3, "#5a5a6a");
    p(qx + step, qy - 2, 1, 2, "#2a2a2a");
    p(qx + 2 - step, qy - 2, 1, 2, "#2a2a2a");
  }
  const bx = slip ? qx - 4 : Math.round((ox + qx) / 2) - 2;
  const by = slope(bx + 2) - 6;
  p(bx, by, 5, 3, "#5a5e66");
  p(bx + 1, by + 1, 1, 1, "#4aa3ff");
  if (slip) p(ox + 1, oy - 7, 1, 1, "#5a4a3a");
  const gust = Math.sin(t * 0.7) > 0.5;
  for (let i = 0; i < 12; i++) {
    const k = i * 13;
    p(Math.floor((rnd(k) * W + t * (gust ? 70 : 20)) % W), Math.floor(rnd(k + 1) * 20), gust ? 3 : 1, 1, "#ffffff");
  }
  sign(p, W, "#e8eef4", "#5a6a7a", "#3a4a5a");
}

// A nod to The Thing. A red helicopter flies over a base of three blocks with
// lit windows. A dog runs across the snow to the base, stops from 8 s to 11 s,
// and runs on. From 10 s to 11.5 s a dark silhouette shows in a lit window of
// the middle block, while the dog looks back. A blizzard blows.
function husky(p: Px, _a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, H, "#0a1018");
  p(0, 17, W, 7, "#c8d4dc");
  p(0, 17, W, 1, "#e8f0f4");
  const stx = Math.round(W * 0.5);
  const blocks: [number, number, number, number][] = [
    [stx - 20, 11, 16, 6],
    [stx - 2, 9, 22, 8],
    [stx + 22, 12, 12, 5],
  ];
  blocks.forEach(([x, y, w, h], i) => {
    p(x, y, w, h, "#3a4048");
    p(x, y - 1, w, 1, "#d8e4ec");
    for (let k = 0; k < Math.floor(w / 4); k++) {
      const on = rnd(i * 10 + k + Math.floor(t * 3) * (k === 1 ? 1 : 0)) > (k === 1 ? 0.4 : 0.2);
      p(x + 2 + k * 4, y + 2, 2, 2, on ? "#e8c56a" : "#202428");
    }
  });
  p(stx + 16, 4, 1, 5, "#5a6068");
  p(stx + 15, 4, 3, 1, "#5a6068");
  p(stx + 16, 3, 1, 1, Math.floor(t * 2) % 2 ? "#ff3030" : "#401010");
  if (u >= 10 && u < 11.5) {
    p(stx + 6, 11, 2, 3, "#05080a");
    p(stx + 6, 10, 2, 1, "#05080a");
  }
  const hx = Math.round(-14 + (u / 16) * W * 0.7);
  p(hx, 5, 10, 3, "#c84a2a");
  p(hx + 10, 6, 4, 1, "#c84a2a");
  p(hx + 13, 5, 1, 2, "#c84a2a");
  p(hx + 2, 4, 1, 1, "#5a5a5a");
  const rot = Math.floor(t * 12) % 2;
  p(hx - 4 + rot * 4, 3, 14 - rot * 4, 1, "#9aa0a8");
  p(hx + 1, 8, 6, 1, "#3a3a3a");
  const stop = u >= 8 && u < 11;
  const dx = Math.round(W - ((Math.min(u, 8) + (u > 11 ? u - 11 : 0)) / 13) * (W + 20));
  const run = !stop && Math.floor(t * 8) % 2;
  p(dx, 18, 6, 2, "#8a8a90");
  p(dx, 18, 6, 1, "#b8b8c0");
  if (stop) {
    p(dx + 5, 16, 2, 2, "#8a8a90");
    p(dx + 6, 16, 1, 1, "#202020");
  } else {
    p(dx - 1, 17, 2, 2, "#8a8a90");
    p(dx - 1, 17, 1, 1, "#202020");
  }
  p(dx + 6, 17, 1, 1, "#8a8a90");
  p(dx + (run ? 1 : 0), 20, 1, 2, "#6a6a70");
  p(dx + 4 - (run ? 1 : 0), 20, 1, 2, "#6a6a70");
  blizzard(p, W, 5, 22, t, 40, "rgba(230,240,250,0.7)");
  sign(p, W, "#0a1018", "#5a6a7a", "#e8f0f4");
}

// A nod to The X-Files. Two agents walk across the ice to a station. From 9 s
// to 14 s the second agent looks at it and lights it with a beam. Before that,
// from 7 s to 9 s, a shadow slides past a lit window inside the station.
function iceStation(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, H, "#0c1418");
  p(0, 18, W, 6, "#b8c8d0");
  p(0, 18, W, 1, "#e0ecf0");
  const sx = Math.round(W * 0.62);
  p(sx, 9, 30, 9, "#4a5258");
  p(sx, 8, 30, 1, "#d8e4ec");
  p(sx + 4, 12, 4, 3, "#c8b060");
  p(sx + 12, 12, 4, 3, "#c8b060");
  p(sx + 20, 12, 4, 3, "#2a3034");
  if (u > 7 && u < 9) p(sx + 12 + Math.round((u - 7) * 2), 12, 2, 3, "#101418");
  p(sx + 26, 14, 3, 4, "#2a3034");
  p(sx - 6, 13, 5, 5, "#5a6066");
  p(sx - 4, 12, 1, 1, Math.floor(t * 2) % 2 ? "#ff3030" : "#401010");
  const walk = Math.min(1, u / 8);
  const ax = Math.round(W * 0.1 + walk * W * 0.32);
  const look = u > 9 && u < 14;
  const pair: [number, string, string, boolean][] = [
    [ax, "#2a2e33", "#3a2a1e", true],
    [ax + 7, "#3a3530", "#b5452a", false],
  ];
  pair.forEach(([x, coat, hair, tall], i) => {
    const top = tall ? 10 : 11;
    p(x, top, 2, 2, "#c9a184");
    p(x, top, 2, 1, hair);
    if (!tall) p(x - 1, top, 1, 2, hair);
    p(x - 1, top + 2, 4, 5, coat);
    const st = walk < 1 ? Math.floor(t * 4 + i) % 2 : 0;
    p(x - 1 + st, top + 7, 1, 11 - top, coat);
    p(x + 2 - st, top + 7, 1, 11 - top, coat);
    if (i === 1 && look) {
      p(x + 3, top + 1, 1, 1, "#d8d8d0");
      for (let k = 0; k < 24; k++) {
        a(0.25 * (1 - k / 24));
        p(x + 4 + k, Math.round(top + 1 - k * 0.05), 1, 1 + Math.floor(k / 6), "#fff3c4");
      }
      a(1);
    }
  });
  a(0.12);
  for (let i = 0; i < 4; i++) p(Math.round(((t * 4 + (i * W) / 4) % (W + 40)) - 20), 16 + (i % 2), 34, 2, "#e8f4fc");
  a(1);
  snowfall(p, W, 3, 24, t, 6, "#e8f0f4");
  sign(p, W, "#0c1418", "#4a6a5a", "#cfe6d8");
}

// A nod to The Shining. The scene shows a snow maze from above, because a maze
// does not read from the side at 24 px. A small figure and a larger figure
// follow the path, and footprints grow. After 12 s a storm grows and fills the
// strip with white.
function maze(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 18;
  p(0, 0, W, H, "#f0f4f6");
  const cell = 4;
  const cols = Math.floor(W / cell);
  const rows = 6;
  const wall = (c: number, r: number) =>
    (c % 4 === 0 && r !== 2 + (Math.floor(c / 4) % 3)) || r === 0 || r === rows - 1 || (r % 2 === 0 && c % 4 === 2 && rnd(c * 7 + r) > 0.5);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!wall(c, r)) continue;
      p(c * cell, r * cell, cell, cell, "#1e4a2a");
      p(c * cell, r * cell, cell, 1, "#ffffff");
    }
  }
  const path = (s: number): [number, number] => [Math.round(W * 0.05 + s * W * 0.06), Math.round(10 + Math.sin(s * 1.3) * 5)];
  const kidS = u < 6 ? u : u < 8 ? 6 - (u - 6) : 4 + (u - 8) * 0.4;
  const prints = Math.floor(Math.min(u, 6) * 3);
  for (let i = 0; i < prints; i++) {
    const [fx, fy] = path(i / 3);
    p(fx, fy + 1, 1, 1, "#9aa6aa");
  }
  const [kx, ky] = path(kidS);
  if (u < 9) {
    p(kx, ky, 2, 2, "#3a6ea8");
    p(kx, ky, 1, 1, "#d0a080");
  } else {
    const [ex, ey] = path(4 + (u - 9) * 0.3);
    p(ex, ey - 3, 2, 2, "#3a6ea8");
  }
  const manS = u < 3 ? 0 : Math.min(6, (u - 3) * 0.9);
  const [mx, my] = path(manS);
  p(mx, my, 3, 3, "#5a3a2a");
  p(mx + 1, my, 1, 1, "#c09070");
  if (manS >= 6 && Math.floor(t * 2) % 2) {
    p(mx + 3, my - 2, 1, 1, "#202020");
    p(mx - 1, my - 2, 1, 1, "#202020");
  }
  const storm = u > 12 ? Math.min(1, (u - 12) / 3) : 0;
  snowfall(p, W, 4, 10 + Math.round(storm * 40), t, 10 + storm * 30, "#ffffff");
  if (storm) {
    a(storm * 0.5);
    p(0, 0, W, H, "#ffffff");
    a(1);
  }
  sign(p, W, "#1e4a2a", "#0e2a16", "#f0f4f6");
}

// A nod to Star Trek VI: The Undiscovered Country. Two figures walk across a
// snow field with three lit posts. From 9 s to 12 s a beam takes them away, and
// they stay away until 15.5 s. A blizzard blows.
function colony(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, H, "#1a2028");
  for (let x = 0; x < W; x++) {
    const h = Math.round(5 + 3 * Math.sin(x * 0.06) + 2 * Math.sin(x * 0.17));
    p(x, 17 - h, 1, h, "#3a4450");
  }
  p(0, 17, W, 7, "#c8d0d8");
  p(0, 17, W, 1, "#e8eef2");
  for (let i = 0; i < 3; i++) {
    const lx = Math.round(W * (0.2 + i * 0.3));
    p(lx, 8, 1, 9, "#2a3038");
    p(lx - 1, 7, 3, 1, Math.floor(t * 2 + i) % 3 === 0 ? "#ff6a2a" : "#6a2a1a");
    a(0.15);
    p(lx - 6, 8, 13, 9, "#ff8a3a");
    a(1);
  }
  const gx = Math.round(W * 0.15 + ((Math.sin(t * 0.4) + 1) / 2) * W * 0.25);
  p(gx, 9, 3, 3, "#5a4a3a");
  p(gx - 1, 12, 5, 5, "#3a3028");
  p(gx - 2, 12, 1, 3, "#6a5a4a");
  p(gx + 4, 10, 1, 6, "#8a8a90");
  const beam = u >= 9 && u < 12;
  const gone = u >= 12 && u < 15.5;
  const walk = Math.min(1, u / 8);
  const kx = Math.round(W * 0.55 + walk * W * 0.15);
  if (!gone) {
    a(beam ? Math.max(0, 1 - (u - 9) / 2.5) : 1);
    person(p, kx, 18, "#8a7a5a", "#d8b090", "#6a4a2a", walk < 1 ? Math.floor(t * 4) % 2 : 0);
    person(p, kx + 6, 18, "#7a6a5a", "#d8b090", "#9a9aa0", walk < 1 ? Math.floor(t * 4 + 1) % 2 : 0);
    a(1);
  }
  if (beam) {
    for (const bx of [kx, kx + 6]) {
      for (let i = 0; i < 6; i++) {
        const k = i + Math.floor(t * 14) * 6 + bx;
        p(bx - 1 + Math.floor(rnd(k) * 4), 10 + Math.floor(rnd(k + 1) * 8), 1, 1, rnd(k + 2) > 0.5 ? "#ffe8a0" : "#8ad0ff");
      }
    }
    a(0.25);
    p(kx - 1, 9, 4, 9, "#ffe8a0");
    p(kx + 5, 9, 4, 9, "#ffe8a0");
    a(1);
  }
  blizzard(p, W, 7, 26, t, 50, "rgba(240,244,248,0.75)");
  sign(p, W, "#1a2028", "#8a5a3a", "#ffb07a");
}

/** WINTERFEST holds the eight winterfest scenes, in the order of rotation. Each name is unique. */
export const WINTERFEST: Script[] = [
  { name: "The Walker Falls", period: 18, still: 12.5, draw: walker },
  { name: "The Gate under the Ice", period: 18, still: 10, draw: iceGate },
  { name: "The Ship in the Glacier", period: 16, still: 11, draw: glacier },
  { name: "The Climb", period: 16, still: 8, draw: climb },
  { name: "The Dog in the Snow", period: 16, still: 10.5, draw: husky },
  { name: "The Station in the Ice", period: 16, still: 10, draw: iceStation },
  { name: "The Maze", period: 18, still: 10, draw: maze },
  { name: "The Prison Colony", period: 16, still: 10, draw: colony },
];

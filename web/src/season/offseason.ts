// chalk-web -- 129-18: the ten off-season scenes.
//
// A date in no season shows one of these scenes. Each scene is a nod to a film
// or a series, and a person knows it by one famous moment. A scene has no
// title, no logo, and no likeness of an actor. The only text is the CHALK sign,
// and the six numbers that The Hatch types. A scene uses a motif and
// does not copy the design of a ship or a car.
// A scene here is a Script (strip.ts): one draw function of the time. A script
// paints an opaque strip of STRIP_H scene pixels, with its own background. The
// rows of scene.ts are see-through. scene.ts runs a script in place of a row
// for the "neutral" key. strip.ts holds the types and the helpers that these
// scripts share with christmas.ts: rnd, sign, stars, and disc.
// Pure: a script uses no timer, no DOM, and no random source. rnd takes its
// places from a hash of an index, so the same time gives the same picture.

import { disc, rnd, sign, stars, STRIP_H, type Alpha, type Px, type Script } from "./strip";

const H = STRIP_H;

// A nod to Back to the Future.
function timeCar(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 14;
  p(0, 0, W, H, "#0b1430");
  stars(p, W, 1, Math.floor(W / 9), 12, t);
  for (let i = 0; i < 4; i++) {
    const bx = 2 + i * 9;
    const bh = 6 + Math.floor(rnd(i + 3) * 4);
    p(bx, 20 - bh, 8, bh, i % 2 ? "#25304a" : "#2c3654");
    for (let wy = 21 - bh; wy < 19; wy += 3) {
      for (let wx = bx + 1; wx < bx + 7; wx += 3) if (rnd(wx * 3 + wy) > 0.35) p(wx, wy, 1, 1, "#f2c66b");
    }
  }
  const cx = Math.max(52, Math.round(W * 0.22));
  p(cx - 12, 12, 25, 8, "#3a4561");
  for (let k = 0; k < 4; k++) p(cx - 12 + k * 3, 11 - k, 25 - k * 6, 1, "#4a5675");
  p(cx - 2, 3, 5, 5, "#4a5675");
  p(cx - 1, 4, 3, 3, "#f6e7a1");
  p(cx, 5, 1, 1, "#3a3020");
  for (let i = 0; i < 5; i++) p(cx - 10 + i * 5, 13, 1, 7, "#8a93a8");
  for (let i = 0; i < 4; i++) p(cx - 8 + i * 5, 15, 2, 3, "#f2c66b");
  p(cx + 18, 12, 1, 8, "#5b6478");
  p(cx + 17, 11, 3, 1, "#ffe08a");
  p(0, 20, W, 1, "#2f6b4a");
  p(0, 21, W, 3, "#1b2130");
  const X0 = Math.round(W * 0.64);
  const speed = (X0 + 22) / 6;
  const x = Math.round(-22 + speed * Math.min(u, 6));
  if (u < 6) {
    if (u > 3.8) {
      p(x + 20, 17, Math.round((u - 3.8) * 10), 1, "rgba(255,240,170,0.25)");
      const n = Math.floor((u - 3.8) * 10);
      for (let i = 0; i < n; i++) {
        const k = Math.floor(t * 12) * 13 + i;
        p(x + Math.floor(rnd(k) * 22) - 1, 13 + Math.floor(rnd(k + 5) * 9), 1, 1, rnd(k + 9) > 0.5 ? "#7fd8ff" : "#d8f4ff");
      }
    }
    p(x + 1, 15, 3, 2, "#6b6f78");
    p(x + 2, 14, 1, 1, "#9aa0aa");
    p(x + 7, 14, 6, 1, "#a7afb9");
    p(x + 6, 15, 8, 2, "#b8c0c8");
    p(x + 8, 15, 5, 1, "#33415e");
    p(x + 14, 16, 6, 1, "#b8c0c8");
    p(x + 1, 17, 19, 3, "#c3cad1");
    p(x + 1, 18, 19, 1, "#8e959e");
    p(x + 19, 17, 1, 1, "#fff6c0");
    p(x + 3, 19, 3, 3, "#0d0f14");
    p(x + 14, 19, 3, 3, "#0d0f14");
    p(x + 4, 20, 1, 1, "#9aa0aa");
    p(x + 15, 20, 1, 1, "#9aa0aa");
  }
  if (u >= 6 && u < 11.5) {
    const fade = 1 - (u - 6) / 5.5;
    const len = Math.min(70, X0 + 18);
    for (let i = 0; i < len; i++) {
      const fx = X0 + 18 - i;
      const k = fx * 7 + Math.floor(t * 12) * 31;
      if (rnd(k) > fade + 0.15) continue;
      const h = 1 + Math.floor(rnd(k + 1) * 3 * fade + 0.4);
      p(fx, 21 - h, 1, h, rnd(k + 2) > 0.5 ? "#ff8a1e" : "#ffd23a");
      p(fx, 21, 1, 1, "#ff5a1e");
    }
  }
  if (u >= 6 && u < 6.5) {
    a(1 - (u - 6) / 0.5);
    p(0, 0, W, H, "#e6f6ff");
    a(1);
  }
  sign(p, W, "#101a33", "#38507e", "#ffd23a");
}

// A nod to Knight Rider.
function highway(p: Px, _a: Alpha, W: number, t: number): void {
  p(0, 0, W, 9, "#090d22");
  p(0, 9, W, 8, "#111536");
  stars(p, W, 2, Math.floor(W / 10), 10, t);
  const mx = Math.round(W * 0.74);
  disc(p, mx, 4, 3, "#f1eccf");
  p(mx - 1, 3, 1, 1, "#cfc9a8");
  p(mx + 1, 5, 1, 1, "#cfc9a8");
  const o1 = t * 1.5;
  for (let x = 0; x < W; x++) {
    const wx = x + o1;
    const h = 3 + Math.round(2 * Math.sin(wx * 0.05) + 1.5 * Math.sin(wx * 0.13 + 1));
    p(x, 16 - h, 1, h + 1, "#2a2350");
  }
  const o2 = t * 5;
  for (let x = 0; x < W; x++) {
    const wx = Math.floor(x + o2);
    const seg = Math.floor(wx / 7);
    const h = rnd(seg * 1.3) > 0.45 ? 2 + Math.floor(rnd(seg) * 5) : 0;
    if (h) {
      p(x, 17 - h, 1, h, "#171a33");
      if (wx % 3 === 0 && rnd(seg * 9 + (wx % 7)) > 0.5) p(x, 17 - h + 1, 1, 1, "#e9c46a");
    }
  }
  p(0, 17, W, 1, "#4b5368");
  const po = Math.floor(t * 24) % 12;
  for (let x = -po; x < W; x += 12) p(x, 16, 1, 2, "#6c7590");
  p(0, 18, W, 6, "#171a22");
  const d = Math.floor(t * 30) % 16;
  for (let x = -d; x < W; x += 16) p(x, 21, 6, 1, "#5d6577");
  const x0 = Math.round(W * 0.26);
  p(x0 + 2, 22, 22, 1, "#0a0b10");
  p(x0 + 7, 14, 9, 1, "#1f3655");
  p(x0 + 6, 15, 11, 2, "#0b0c11");
  p(x0 + 8, 15, 7, 1, "#1d3550");
  p(x0, 17, 26, 3, "#0b0c11");
  p(x0 + 1, 17, 22, 1, "#2a3448");
  p(x0 + 22, 18, 5, 2, "#0b0c11");
  p(x0, 18, 1, 1, "#ff3b3b");
  p(x0 + 20, 18, 7, 1, "#2a0606");
  const s = Math.round(((Math.sin(t * 3.4) + 1) / 2) * 6);
  p(x0 + 20 + s, 18, 1, 1, "#ff3030");
  if (s > 0) p(x0 + 19 + s, 18, 1, 1, "#9a1212");
  if (s < 6) p(x0 + 21 + s, 18, 1, 1, "#9a1212");
  p(x0 + 18 + s, 21, 4, 1, "rgba(255,40,40,0.18)");
  p(x0 + 3, 20, 4, 2, "#05050a");
  p(x0 + 18, 20, 4, 2, "#05050a");
  p(x0 + 4, 20, 2, 1, "#6f7684");
  p(x0 + 19, 20, 2, 1, "#6f7684");
  sign(p, W, "#0c0f22", "#8a1c1c", "#f0f0f0");
}

// A nod to The Matrix.
function rooftop(p: Px, _a: Alpha, W: number, t: number): void {
  const period = 12;
  const cyc = Math.floor(t / period);
  const u = t % period;
  const warp = (v: number) => (v < 5 ? v : v < 9 ? 5 + (v - 5) * 0.12 : 5.48 + (v - 9));
  const rt = cyc * (5.48 + 3) + warp(u);
  p(0, 0, W, H, "#020a05");
  for (let x = 0; x < W; x++) {
    const seg = Math.floor(x / 9);
    const h = 4 + Math.floor(rnd(seg + 40) * 9);
    p(x, 20 - h, 1, h, "#04170b");
    if (x % 9 > 1 && x % 9 < 7 && x % 2 === 0) {
      for (let y = 21 - h; y < 19; y += 2) if (rnd(x * 5 + y) > 0.6) p(x, y, 1, 1, "#1d5a2c");
    }
  }
  for (let c = 0; c * 3 < W; c++) {
    const sp = 6 + rnd(c) * 10;
    const off = rnd(c + 99) * 40;
    const head = Math.floor((rt * sp + off) % 36) - 8;
    for (let k = 0; k < 7; k++) {
      const y = head - k;
      if (y < 0 || y > 19) continue;
      if (rnd(c * 31 + y + Math.floor(rt * 4) * 7) < 0.25) continue;
      p(c * 3 + 1, y, 1, 1, k === 0 ? "#c8ffc8" : k < 3 ? "#2fd36a" : "#0f5a26");
    }
  }
  p(0, 20, W, 1, "#1e4a2c");
  p(0, 21, W, 3, "#0a1a10");
  p(2, 14, 14, 6, "#0c2014");
  p(7, 16, 4, 4, "#0f3a1f");
  p(8, 15, 2, 1, "#5fe38a");
  const nx = Math.round(W * 0.36);
  const lean = u < 5.2 ? 0 : u < 6 ? ((u - 5.2) / 0.8) * 3 : u < 9.5 ? 3 : u < 10.3 ? 3 - ((u - 9.5) / 0.8) * 3 : 0;
  const L = Math.round(lean);
  p(nx - 1 - L, 11 + Math.floor(L / 2), 3, 2, "#c9a98a");
  p(nx - 1 - L, 11 + Math.floor(L / 2), 3, 1, "#111111");
  p(nx - L, 12 + Math.floor(L / 2), 2, 1, "#000000");
  for (let y = 13; y <= 16; y++) {
    const dx = Math.round((L * (17 - y)) / 4);
    p(nx - 1 - dx, y + (L > 1 && y < 15 ? 1 : 0), 4, 1, "#070907");
  }
  const flap = Math.round(Math.sin(t * (u > 5 && u < 9.5 ? 2 : 6)));
  p(nx - 2 - L + flap, 17, 6, 1, "#070907");
  p(nx - 3 - L + flap, 18, 2, 1, "#070907");
  p(nx - 1, 18, 1, 2, "#070907");
  p(nx + 2, 18, 1, 2, "#070907");
  p(nx - 2 - L, 13, 1, 4, "#1e4a2c");
  const ax = Math.round(W * 0.7);
  p(ax, 11, 2, 2, "#c9a98a");
  p(ax, 11, 2, 1, "#222222");
  p(ax, 12, 2, 1, "#000000");
  p(ax - 1, 13, 4, 5, "#101210");
  p(ax, 13, 1, 2, "#e8e8e8");
  p(ax, 14, 1, 1, "#101210");
  p(ax - 1, 18, 1, 2, "#101210");
  p(ax + 2, 18, 1, 2, "#101210");
  const firing = u > 4.2 && u < 5.4;
  if (firing || (u > 3.6 && u < 9)) p(ax - 5, 14, 5, 1, "#101210");
  if (firing && Math.floor(t * 12) % 2 === 0) {
    p(ax - 7, 13, 2, 3, "#ffd23a");
    p(ax - 8, 14, 1, 1, "#fff6c0");
  }
  [4.4, 4.75, 5.1].forEach((s0, i) => {
    if (u < s0) return;
    const slow = Math.min(u - s0, Math.max(0, 9 - s0));
    const dist = slow * 22 + Math.max(0, u - 9) * 240;
    const bx = Math.round(ax - 8 - dist);
    const by = 12 + i;
    if (bx < -4) return;
    p(bx, by, 2, 1, "#f2e9a0");
    if (u < 9) {
      for (let r = 1; r < 4; r++) p(bx + 2 + r * 3, by + (r % 2 ? -1 : 1), 1, 1, `rgba(160,255,190,${0.5 - r * 0.12})`);
    }
  });
  for (let i = 0; i < 2; i++) {
    const gx = Math.round(W * 0.86) + i * 5;
    p(gx, 13, 2, 2, "#1a3a24");
    p(gx - 1, 15, 4, 5, "#0b1a10");
  }
  sign(p, W, "#03120a", "#1e6a3a", "#5fe38a");
}

// A nod to Star Trek.
function starship(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, H, "#05060f");
  for (let i = 0; i < 16; i++) {
    const k = i * 11 + 300;
    if (rnd(k + 2) > 0.5) p(Math.floor(rnd(k) * W), Math.floor(rnd(k + 1) * H), 1, 1, "rgba(150,90,200,0.35)");
  }
  const warp = u > 10.4 && u < 13.5 ? Math.min(1, (u - 10.4) / 0.6) * (u > 12.5 ? 13.5 - u : 1) : 0;
  for (let i = 0; i < Math.floor(W / 4); i++) {
    const layer = 1 + (i % 3);
    const sx = (rnd(i) * W - t * layer * 1.5) % W;
    const x = Math.floor(sx < 0 ? sx + W : sx);
    const y = Math.floor(rnd(i + 50) * H);
    const len = 1 + Math.round(warp * layer * 6);
    p(x - len + 1, y, len, 1, layer === 3 ? "#ffffff" : layer === 2 ? "#9fb0d8" : "#4a5578");
  }
  for (let y = 14; y < H; y++) {
    for (let x = 0; x < Math.min(W, 40); x++) {
      const d = Math.hypot(x - 6, y - 38);
      if (d < 24) p(x, y, 1, 1, d > 23 ? "#8fc2ff" : (x + y) % 5 === 0 ? "#2e6aa8" : "#1d4a80");
    }
  }
  const gx = Math.round(W * 0.8);
  for (let y = 2; y <= 14; y++) {
    const dx = Math.sqrt(Math.max(0, 36 - (y - 8) * (y - 8)));
    if (!dx) continue;
    p(Math.round(gx - dx), y, Math.round(dx * 2), 1, ["#c4672c", "#e08a46", "#a9512a", "#e7a35d"][y % 4]);
  }
  disc(p, Math.round(W * 0.68), 15, 1, "#c27a4a");
  let x: number;
  if (u < 10.4) x = Math.round(-26 + (u * (W * 0.42 + 26)) / 10.4);
  else if (u < 10.9) x = Math.round(W * 0.42 + (u - 10.4) * 2 * W);
  else x = W + 99;
  const y = 6;
  if (x < W + 30) {
    if (u > 10.3 && u < 10.9) {
      for (let s = 0; s < 40; s++) p(x - s, y + 4, 1, 1, `rgba(140,200,255,${0.5 - s / 90})`);
    }
    p(x - 3, y + 3, 3, 1, "rgba(74,163,255,0.35)");
    p(x - 1, y + 3, 1, 2, u > 9 && u < 10.4 ? "#bfe4ff" : "#4aa3ff");
    p(x, y + 3, 10, 1, "#c7cbd3");
    p(x, y + 4, 10, 1, "#8f96a2");
    p(x + 10, y + 3, 1, 2, "#ff4b3a");
    p(x + 5, y + 5, 1, 1, "#9aa0ab");
    p(x + 4, y + 6, 9, 2, "#b5bac4");
    p(x + 4, y + 7, 9, 1, "#8f96a2");
    p(x + 13, y + 6, 1, 1, "#e8a050");
    p(x + 11, y + 4, 1, 2, "#9aa0ab");
    p(x + 12, y + 3, 1, 1, "#9aa0ab");
    p(x + 13, y + 1, 9, 1, "#d2d6dd");
    p(x + 11, y + 2, 13, 1, "#b0b5bf");
    p(x + 13, y + 3, 9, 1, "#878d9a");
    p(x + 16, y, 3, 1, "#e6e9ee");
  }
  if (u >= 10.9 && u < 11.3) {
    a(1 - (u - 10.9) / 0.4);
    p(W - 6, y + 1, 6, 5, "#ffffff");
    p(0, 0, W, H, "rgba(200,230,255,0.25)");
    a(1);
  }
  sign(p, W, "#080a18", "#2f9e6a", "#f2e27a");
}

// A nod to Stargate SG-1.
function gate(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 20;
  ["#2a2a5a", "#4a3a6a", "#7a4a6a", "#b8645a", "#e08a52", "#f0b064"].forEach((c, i) => p(0, i * 3, W, 3, c));
  disc(p, Math.round(W * 0.12), 6, 2.5, "#ffe2a0");
  for (let x = 0; x < W; x++) {
    const h = Math.round(1.5 + Math.sin(x * 0.04) * 1.5 + Math.sin(x * 0.13 + 1));
    p(x, 18 - h, 1, h + 6, "#c8925a");
  }
  p(0, 20, W, 4, "#b07c48");
  const px = Math.round(W * 0.3);
  const base = 19;
  const ph = 13;
  for (let y = 0; y < ph; y++) {
    const half = Math.round((y + 1) * 1.3);
    p(px - half, base - ph + y, half, 1, "#d8a868");
    p(px, base - ph + y, half, 1, "#a87848");
  }
  p(px - 1, base - ph - 1, 2, 1, "#f0d090");
  p(px - 2, base - 3, 4, 3, "#3a2418");
  const gx = Math.round(W * 0.7);
  const gy = 10;
  const R = 9;
  const r = 7;
  p(gx - 12, 19, 25, 1, "#8a7a68");
  p(gx - 14, 20, 29, 1, "#7a6a58");
  for (let i = 0; i < 4; i++) p(gx - 22 + i * 2, 20 - Math.floor(i / 2), 2, 1, "#8a7a68");
  if (u >= 6.6 && u < 15) {
    for (let y = gy - r; y <= gy + r; y++) {
      for (let x = gx - r; x <= gx + r; x++) {
        const d = Math.hypot(x - gx, y - gy);
        if (d > r) continue;
        const wave = Math.sin(d * 1.6 - t * 5) + Math.sin((x - gx) * 0.9 + t * 3) * 0.5;
        p(x, y, 1, 1, wave > 0.9 ? "#d8f4ff" : wave > 0 ? "#5ab4ff" : "#2a6ad8");
      }
    }
    if (u < 7.4) {
      const k = (u - 6.6) / 0.8;
      a(0.85 * (1 - k * 0.6));
      disc(p, gx, gy, r + Math.sin(k * Math.PI) * 6, "#e8f8ff", 20);
      a(1);
    }
  }
  for (let y = gy - R; y <= gy + R; y++) {
    for (let x = gx - R; x <= gx + R; x++) {
      const d = Math.hypot(x - gx, y - gy);
      if (d > R + 0.3 || d < r + 0.3) continue;
      const ang = Math.atan2(y - gy, x - gx);
      const glyph = Math.floor((ang + Math.PI) * 6 + (u < 6.6 && u > 0.4 ? u * 4 : 0)) % 3 === 0;
      p(x, y, 1, 1, d > R - 0.7 ? "#5a5e66" : glyph ? "#6a6e76" : "#8a8f98");
    }
  }
  const order = [1, 2, 3, 6, 7, 8, 0];
  const locked = u < 15 ? Math.min(7, Math.floor(Math.max(0, u - 0.8) / 0.8)) : 0;
  for (let i = 0; i < 9; i++) {
    const ang = ((-90 + i * 40) * Math.PI) / 180;
    const cx = Math.round(gx + Math.cos(ang) * (R - 0.5));
    const cy = Math.round(gy + Math.sin(ang) * (R - 0.5));
    const at = order.indexOf(i);
    const on = at > -1 && at < locked;
    const blink = on && at === locked - 1 && u < 6.6 && Math.floor(t * 8) % 2 === 0;
    const top = i === 0;
    p(cx - (top ? 1 : 0), cy - (top ? 1 : 0), top ? 3 : 2, 2, on ? (blink ? "#ffd27a" : "#ff7a1a") : "#7a4a2a");
  }
  const team = [
    { hair: "#3a3a2a", skin: "#d0a080", cap: true, mark: false, tall: false, glasses: false },
    { hair: "#e0c070", skin: "#e0b090", cap: false, mark: false, tall: false, glasses: false },
    { hair: "#1a120c", skin: "#5a3a26", cap: false, mark: true, tall: true, glasses: false },
    { hair: "#6a4a2a", skin: "#d0a080", cap: false, mark: false, tall: false, glasses: true },
  ];
  team.forEach((m, i) => {
    const t0 = 8 + i * 0.9;
    if (u < t0 || u > 19.5) return;
    const x = Math.round(gx - 1 - (u - t0) * 9);
    if (x < px + 8) return;
    const by = x < gx - 13 ? 20 : 19;
    const top = by - (m.tall ? 8 : 7);
    a(u - t0 < 0.4 ? (u - t0) / 0.4 : 1);
    p(x, top, 2, 2, m.skin);
    p(x, top, 2, 1, m.cap ? "#3e4a2e" : m.hair);
    if (m.mark) p(x, top, 1, 1, "#e0b030");
    if (m.glasses) p(x, top + 1, 1, 1, "#20201a");
    p(x - 1, top + 2, 4, 3, "#4e5e3a");
    p(x - 1, top + 3, 4, 1, "#2e3a24");
    p(x - 2, top + 3, 2, 1, "#202020");
    const step = Math.floor(t * 6 + i) % 2;
    p(x + step, top + 5, 1, by - top - 5, "#3e4a2e");
    p(x + 2 - step, top + 5, 1, by - top - 5, "#3e4a2e");
    a(1);
  });
  if (u >= 15 && u < 15.4) {
    a(1 - (u - 15) / 0.4);
    disc(p, gx, gy, r, "#bfe6ff");
    a(1);
  }
  sign(p, W, "#2a2240", "#a8784a", "#f0d090");
}

// A nod to Tron.
function lightCycles(p: Px, a: Alpha, W: number, t: number): void {
  const v = 70;
  const cx = Math.round(W * 0.5);
  const period = (W + 60) / v + 2.5;
  const u = t % period;
  p(0, 0, W, H, "#03050c");
  for (let y = 3; y < H; y += 6) p(0, y, W, 1, "#0b1830");
  for (let x = 4; x < W; x += 8) p(x, 0, 1, H, "#0b1830");
  type Pt = [number, number];
  const cyanPath: Pt[] = [[-4, 9], [cx, 9], [cx, 19], [W + 40, 19]];
  const cyanLen = cx + 4 + 10 + (W + 40 - cx);
  const walk = (path: Pt[], d: number): Pt[] => {
    let rest = d;
    const pts: Pt[] = [path[0]];
    for (let i = 1; i < path.length; i++) {
      const [ax, ay] = path[i - 1];
      const [bx, by] = path[i];
      const seg = Math.abs(bx - ax) + Math.abs(by - ay);
      if (rest >= seg) {
        pts.push(path[i]);
        rest -= seg;
        continue;
      }
      const f = rest / seg;
      pts.push([ax + (bx - ax) * f, ay + (by - ay) * f]);
      return pts;
    }
    return pts;
  };
  const wall = (pts: Pt[], color: string, alpha: number) => {
    a(alpha);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      p(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax) + 1, Math.abs(by - ay) + 1, color);
    }
    a(1);
  };
  const endFade = u > period - 1.2 ? (period - u) / 1.2 : 1;
  const cp = walk(cyanPath, Math.min(u * v, cyanLen));
  wall(cp, "#38e8ff", endFade);
  const [hx, hy] = cp[cp.length - 1];
  if (hx < W + 2 && endFade > 0.5) p(Math.round(hx) - 2, Math.round(hy) - 1, 4, 3, "#d8fbff");
  const passT = (cx + 4 + 7) / v;
  const delay = 0.45;
  const orangeX = W + 4 - Math.max(0, u - delay) * v;
  const hitX = cx + 1;
  const hitT = delay + (W + 4 - hitX) / v;
  const hit = u >= hitT && hitT >= passT;
  const ox = hit ? hitX : orangeX;
  const oFade = hit ? Math.max(0, 1 - (u - hitT) / 1.2) : endFade;
  if (u > delay) wall([[W + 4, 16], [ox, 16]], "#ff8a1e", oFade);
  if (!hit && u > delay) p(Math.round(ox) - 1, 15, 4, 3, "#ffe0b8");
  if (hit && u - hitT < 1.4) {
    const e = u - hitT;
    a(Math.max(0, 1 - e / 1.4));
    for (let i = 0; i < 26; i++) {
      const ang = rnd(i) * Math.PI * 2;
      const sp = 6 + rnd(i + 9) * 20;
      p(Math.round(hitX + Math.cos(ang) * sp * e), Math.round(16 + Math.sin(ang) * sp * e * 0.6), 1, 1, i % 3 ? "#ffb15a" : "#fff2d8");
    }
    a(1);
  }
  sign(p, W, "#05080f", "#1a6a8a", "#38e8ff");
}

// A nod to Star Wars.
function twinSuns(p: Px, a: Alpha, W: number, t: number): void {
  const period = 20;
  const u = t % period;
  ["#24163f", "#3a1d4c", "#5a2650", "#86344c", "#b24b40", "#d8703a", "#eb9a46", "#f4bd5e"].forEach((c, i) =>
    p(0, i * 2, W, 2, c),
  );
  const sink = (u / period) * 6;
  a(u > period - 1.5 ? (period - u) / 1.5 : u < 1 ? u : 1);
  disc(p, Math.round(W * 0.66), 10 + sink, 3.2, "#ffe7a6", 17);
  disc(p, Math.round(W * 0.73), 12.5 + sink, 2, "#ffcf78", 17);
  a(1);
  for (let x = 0; x < W; x++) {
    const h1 = Math.round(1.5 + 1.5 * Math.sin(x * 0.045) + Math.sin(x * 0.11));
    p(x, 16 - h1, 1, h1 + 8, "#b97c45");
    const h2 = Math.round(1 + 1.2 * Math.sin(x * 0.07 + 2));
    p(x, 19 - h2, 1, h2 + 5, "#93603a");
  }
  const dx = Math.round(W * 0.17);
  disc(p, dx, 18, 3.5, "#d8b98a", 19);
  p(dx - 1, 17, 2, 2, "#3a2418");
  const fx = Math.round(W * 0.34);
  const c = "#2a180f";
  p(fx, 11, 2, 2, c);
  p(fx - 1, 13, 4, 3, c);
  p(fx - 1, 16, 4, 2, c);
  p(fx + 2 + (Math.floor(t * 2) % 2), 15, 1, 2, c);
  for (let i = 0; i < 14; i++) {
    const k = i * 17;
    const sx = (rnd(k) * W + t * (20 + rnd(k + 1) * 20)) % W;
    p(Math.floor(sx), 15 + Math.floor(rnd(k + 2) * 7), 1, 1, "rgba(255,225,170,0.55)");
  }
  sign(p, W, "#2a173f", "#a8603a", "#f4bd5e");
}

// The digits of the numbers that are typed in The Hatch: three pixels wide.
const DIGITS: Record<string, string[]> = {
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "8": ["111", "101", "111", "101", "111"],
};

// A nod to Lost.
function hatch(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 18;
  p(0, 0, W, 6, "#173a5e");
  p(0, 6, W, 5, "#2a5f86");
  p(0, 11, W, 3, "#4f8fb3");
  const sea = Math.round(W * 0.55);
  p(0, 14, sea, 3, "#1f6f8f");
  for (let x = 0; x < sea; x += 7) p((x + Math.floor(t * 3)) % sea, 15, 3, 1, "#7fc4d8");
  p(0, 17, sea, 1, "#e8f4f4");
  p(0, 18, sea, 6, "#d9c08a");
  for (let i = 0; i < 12; i++) p(Math.floor(rnd(i + 70) * sea), 19 + Math.floor(rnd(i + 71) * 4), 1, 1, "#bfa06a");
  const fx = Math.round(W * 0.12);
  p(fx, 14, 22, 5, "#c9ced4");
  p(fx, 14, 22, 1, "#e6e9ec");
  p(fx, 17, 22, 1, "#3a6ea8");
  for (let i = 0; i < 5; i++) p(fx + 3 + i * 4, 15, 2, 1, "#2a3440");
  for (let y = 14; y < 19; y++) p(fx + 22 + ((y * 3) % 2), y, 1 + (y % 3), 1, "#8a9098");
  p(fx - 2, 13, 2, 6, "#5a6068");
  const tx = fx + 34;
  p(tx, 9, 3, 9, "#c9ced4");
  p(tx + 3, 7, 2, 11, "#c9ced4");
  p(tx + 3, 7, 2, 2, "#3a6ea8");
  p(tx - 2, 17, 9, 2, "#9aa0a8");
  p(fx + 10, 19, 2, 1, "#5a4a3a");
  p(fx + 24, 20, 4, 1, "#8a9098");
  for (let i = 0; i < 9; i++) {
    const age = (t * 0.6 + rnd(i * 5)) % 1;
    a(0.45 * (1 - age));
    p(tx + 5 + Math.round(Math.sin(age * 6 + i) * 2 + age * 6), Math.round(16 - age * 15), 2, 2, "#6a6f74");
  }
  a(1);
  const palm = (x: number, h: number, lean: number) => {
    for (let y = 0; y < h; y++) p(x + Math.round((lean * y) / h), 19 - y, 1, 1, "#6a4a2a");
    const top = x + lean;
    const ty = 19 - h;
    const sway = Math.round(Math.sin(t * 1.5 + x));
    p(top - 4, ty + sway, 4, 1, "#2f7a3a");
    p(top + 1, ty - sway, 4, 1, "#2f7a3a");
    p(top - 5, ty + 1 + sway, 2, 1, "#2f7a3a");
    p(top + 4, ty + 1 - sway, 2, 1, "#2f7a3a");
    p(top - 1, ty - 1, 3, 1, "#3f9a4a");
  };
  p(sea, 9, W - sea, 15, "#16301c");
  for (let x = sea; x < W; x++) {
    const h = 2 + Math.floor(rnd(Math.floor(x / 4) + 60) * 4);
    p(x, 9 - h, 1, h, "#1d4226");
  }
  palm(Math.round(W * 0.05), 9, 2);
  palm(Math.round(W * 0.5), 11, -2);
  palm(sea + 4, 12, 1);
  const hx = sea + 14;
  const hw = Math.min(W - hx - 4, 78);
  p(hx, 10, hw, 11, "#5f6660");
  p(hx + 1, 11, hw - 2, 9, "#1a1d1a");
  p(hx + 1, 19, hw - 2, 1, "#3a3e3a");
  const chars = "4 8 15 16 23 42";
  const typing = u >= 2 && u < 11;
  const shown = u < 2 ? 0 : Math.min(chars.length, Math.floor((u - 2) / 0.5) + 1);
  const enter = u >= 12 && u < 13.4;
  const sx = hx + 4;
  const sy = 12;
  const sw = Math.min(hw - 18, chars.length * 4 + 4);
  p(sx - 1, sy - 1, sw + 2, 8, "#3a3e38");
  p(sx, sy, sw, 6, enter ? "#1e5a2a" : "#06140a");
  const ink = "#7dff8a";
  if (u < 13.4) {
    p(sx + 1, sy + 3, 1, 1, ink);
    [...chars.slice(0, shown)].forEach((ch, i) => {
      const g = DIGITS[ch];
      if (!g) return;
      g.forEach((row, ry) =>
        [...row].forEach((b, rx) => {
          if (b === "1" && sx + 3 + i * 4 + rx < sx + sw) p(sx + 3 + i * 4 + rx, sy + ry, 1, 1, ink);
        }),
      );
    });
  }
  const cursorX = sx + 3 + shown * 4;
  if (Math.floor(t * 3) % 2 === 0 && cursorX < sx + sw - 1) p(cursorX, sy + 5, 2, 1, ink);
  const kx = sx + sw + 4;
  if (kx + 4 < hx + hw) {
    p(kx, 13, 2, 2, "#c9a184");
    p(kx, 13, 2, 1, "#2a1e14");
    p(kx - 1, 15, 4, 3, "#4a4030");
    p(kx - 2, 18, 6, 1, "#3a3024");
    p(kx - 2, 16 + (typing && Math.floor(t * 8) % 2 === 0 ? 1 : 0), 1, 1, "#c9a184");
  }
  p(sx, sy + 7, sw, 1, "#2a2e28");
  if (enter && Math.floor(t * 6) % 2 === 0) p(sx + sw - 3, sy + 7, 2, 1, "#ffd23a");
  sign(p, W, "#10283e", "#3a6e5a", "#e8f4f4");
}

// A nod to Stranger Things.
function shadowTown(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 18;
  const flash = [2.6, 7.2, 9.6, 11.2, 15.8].find((b) => u >= b && u < b + 0.18);
  const lit = flash !== undefined;
  const sky = lit ? ["#5a0f14", "#7a1a1c", "#9a2a22"] : ["#12060a", "#260a10", "#3a0e14"];
  p(0, 0, W, 6, sky[0]);
  p(0, 6, W, 6, sky[1]);
  p(0, 12, W, 8, sky[2]);
  for (let i = 0; i < 10; i++) {
    const k = i * 9;
    const cx = ((rnd(k) * W + t * (1 + rnd(k + 1) * 2)) % (W + 30)) - 15;
    p(Math.round(cx), Math.floor(rnd(k + 2) * 6), 12 + Math.floor(rnd(k + 3) * 10), 1, lit ? "#b0302a" : "#4a1218");
  }
  const mx = Math.round(W * 0.68);
  const recoil = u < 11.2 ? 0 : Math.min(1, (u - 11.2) / 2.2);
  const back = u > 16.5 ? (u - 16.5) / 1.5 : 0;
  const mAlpha = Math.min(1, Math.max(0, 1 - recoil) + back);
  const mColor = lit ? "#050203" : "#0b0407";
  if (mAlpha > 0.02) {
    a(mAlpha);
    const sway = Math.sin(t * 0.8) * 2;
    const lift = Math.round(recoil * 4);
    for (let i = 0; i < 6; i++) {
      const off = i - 2.5;
      const x0 = mx + off * 3;
      const y0 = 7 - lift;
      const x1 = mx + off * 10 + sway;
      const y1 = 1 - lift;
      const x2 = mx + off * 13 + Math.sin(t * 0.9 + i) * 2;
      const y2 = 20 - lift * 2;
      for (let s = 1; s <= 24; s++) {
        const q = s / 24;
        const x = (1 - q) * (1 - q) * x0 + 2 * (1 - q) * q * x1 + q * q * x2;
        const y = (1 - q) * (1 - q) * y0 + 2 * (1 - q) * q * y1 + q * q * y2;
        p(Math.round(x), Math.round(y), q < 0.4 ? 2 : 1, 1, mColor);
      }
    }
    for (let y = -3; y <= 3; y++) {
      const half = Math.round(Math.sqrt(Math.max(0, 1 - (y * y) / 12)) * 8);
      p(mx - half, 5 + y - lift, half * 2 + 1, 1, mColor);
    }
    for (let i = 0; i < 5; i++) {
      const h = 2 + Math.round(Math.sin(t * 1.7 + i * 1.3) + 1);
      p(mx - 6 + i * 3, 3 - lift - h, 1, h, mColor);
    }
    if (lit) p(mx - 8, 6 - lift, 17, 1, "#5a0c10");
    a(1);
  }
  for (let i = 0; i < 4; i++) {
    const hx = Math.round(W * 0.42) + i * 17;
    p(hx, 14, 12, 6, "#0a0508");
    for (let k = 0; k < 4; k++) p(hx - 1 + k, 13 - k, 14 - k * 2, 1, "#0a0508");
    if (i % 2 === 0) p(hx + 4, 16, 2, 2, lit ? "#e8b060" : "#3a1a10");
  }
  const lampOn = Math.floor(t * 7) % 5 !== 0;
  const lx = Math.round(W * 0.06);
  p(lx, 10, 1, 10, "#1a1014");
  p(lx - 1, 9, 3, 1, lampOn ? "#ffb070" : "#3a2018");
  if (lampOn) {
    a(0.18);
    p(lx - 4, 10, 9, 10, "#ffb070");
    a(1);
  }
  p(0, 20, W, 4, "#140a0c");
  p(0, 20, W, 1, "#2a1416");
  if (flash !== undefined) {
    let bx = Math.round(W * (0.3 + rnd(flash) * 0.6));
    for (let by = 0; by < 11; by++) {
      const nx = bx + Math.round((rnd(bx + by) - 0.5) * 4);
      p(Math.min(bx, nx), by, Math.abs(nx - bx) + 1, 1, "#ffd8c8");
      bx = nx;
    }
  }
  for (let i = 0; i < 22; i++) {
    const k = i * 13;
    const age = (t * (0.08 + rnd(k) * 0.08) + rnd(k + 1)) % 1;
    p(Math.floor((rnd(k + 2) * W + Math.sin(t + i) * 3 + W) % W), Math.round(22 - age * 22), 1, 1, "rgba(220,200,200,0.45)");
  }
  const stopX = Math.round(W * 0.3);
  const arrive = Math.min(1, u / 5);
  const raise = u >= 10.6 && u < 13;
  ["#c8402a", "#3a6ea8", "#d9a43a", "#4a8a4a"].forEach((jacket, i) => {
    const x = Math.round(-10 - i * 10 + (stopX - i * 9 + 10 + i * 10) * arrive);
    const pedal = arrive < 1 ? Math.floor(t * 6 + i) % 2 : 0;
    p(x, 19, 2, 2, "#0e0a0c");
    p(x + 5, 19, 2, 2, "#0e0a0c");
    p(x + 1, 18, 5, 1, "#5a5a60");
    p(x + 2, 13, 2, 2, "#d0a080");
    p(x + 2, 13, 2, 1, i === 0 ? "#3a2a20" : i === 2 ? "#e0c070" : "#2a1a12");
    p(x + 2, 15, 2, 2, jacket);
    p(x + 2 + pedal, 17, 1, 1, "#20304a");
    if (arrive < 1 || u <= 5.5 || u >= 15.5) return;
    if (i === 0 && raise) {
      p(x + 4, 13, 1, 2, "#d0a080");
      p(x + 5, 12, 1, 1, "#d0a080");
      p(x + 1, 14, 1, 1, "#c01010");
      a(0.35 * (1 - (u - 10.6) / 2.4));
      disc(p, x + 6, 12, 4, "#ffffff");
      a(1);
      return;
    }
    for (let k = 0; k < 22; k++) {
      a(0.22 * (1 - k / 22));
      p(x + 4 + k, Math.round(15 - k * 0.35), 1, 1 + Math.floor(k / 7), "#fff3c4");
    }
    a(1);
  });
  if (u >= 7.5 && u < 12.2) {
    const reach = u < 10.6 ? (u - 7.5) / 3.1 : Math.max(0, 1 - (u - 10.6) / 0.6);
    const sx = mx - 6;
    const sy = 6;
    const tx = stopX + 12;
    const ty = 11;
    const n = Math.max(1, Math.round(40 * reach));
    for (let s = 0; s <= n; s++) {
      const q = s / 40;
      const x = sx + (tx - sx) * q;
      const y = sy + (ty - sy) * q - Math.sin(q * Math.PI) * 5 + Math.sin(q * 9 + t * 4) * 1.2;
      p(Math.round(x), Math.round(y), 1, q < 0.5 ? 2 : 1, mColor);
    }
  }
  sign(p, W, "#1a070a", "#7a1a1c", "#ff5a4a");
}

// A nod to The X-Files.
function woods(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 16;
  p(0, 0, W, H, "#060a0c");
  p(0, 0, W, 8, "#0a1216");
  stars(p, W, 10, Math.floor(W / 16), 7, t);
  for (let x = 0; x < W; x++) {
    const seg = Math.floor(x / 6);
    const h = 9 + Math.floor(rnd(seg + 21) * 7);
    p(x, 21 - h + Math.abs(x - (seg * 6 + 3)) * 2, 1, h, "#0c1a14");
  }
  for (let i = 0; i < W; i += 23) {
    const tx = i + Math.floor(rnd(i) * 10);
    p(tx, 3, 1, 18, "#0a1310");
    for (let k = 0; k < 5; k++) p(tx - 3 + k, 6 + k * 3 - (k > 2 ? (k - 2) * 2 : 0), 7 - k, 1, "#0f2219");
  }
  p(0, 20, W, 4, "#081008");
  for (let i = 0; i < W; i += 5) p(i + (i % 3), 19, 1, 1, "#10261a");
  const bx = Math.round(W * 0.55 + Math.sin((u - 9) * 1.4) * W * 0.06);
  if (u >= 8.2 && u < 13) {
    a(u < 9 ? (u - 8.2) / 0.8 : u > 12.5 ? (13 - u) / 0.5 : 1);
    p(bx - 4, 1, 9, 1, "#9aa3a8");
    p(bx - 6, 2, 13, 1, "#6c757b");
    for (let i = 0; i < 4; i++) p(bx - 5 + i * 3, 2, 1, 1, Math.floor(t * 6 + i) % 4 === 0 ? "#ffffff" : "#e0f4ff");
    a(1);
  }
  if (u >= 9 && u < 12.5) {
    const s = Math.min(1, (u - 9) / 0.3) * (u > 12.2 ? (12.5 - u) / 0.3 : 1);
    for (let y = 3; y < 21; y++) {
      const half = 2 + Math.round((y - 3) * 0.45);
      a(0.18 * s);
      p(bx - half, y, half * 2 + 1, 1, "#e8f6ff");
      a(0.3 * s);
      p(bx - 1, y, 3, 1, "#ffffff");
    }
    a(1);
    for (let i = 0; i < 6; i++) {
      const k = i * 7;
      const ly = 20 - ((t * (3 + rnd(k) * 3) + rnd(k + 1) * 17) % 17);
      p(bx - 3 + Math.floor(rnd(k + 2) * 7), Math.floor(ly), 1, 1, "#cfefff");
    }
  }
  const ax = Math.round(W * 0.18 + Math.min(u, 8.2) * W * 0.035);
  const look = u >= 8.6 && u < 13.2;
  const agent = (x: number, hair: string, coat: string, tall: boolean, phase: number): [number, number] => {
    const top = tall ? 11 : 12;
    p(x, top, 2, 2, "#c9a184");
    p(x, top, 2, 1, hair);
    if (!tall) p(x - 1, top, 1, 2, hair);
    p(x - 1, top + 2, 4, 5, coat);
    const step = look ? 0 : Math.floor(t * 4 + phase) % 2;
    p(x - 1 + step, top + 7, 1, 20 - top - 7, coat);
    p(x + 2 - step, top + 7, 1, 20 - top - 7, coat);
    p(x + 3, look ? top + 1 : top + 3, 1, 1, "#d8d8d0");
    return [x + 4, look ? top + 1 : top + 3];
  };
  const lights = [agent(ax, "#3a2a1e", "#2a2e33", true, 0), agent(ax + 9, "#b5452a", "#3a3530", false, 1)];
  if (look) {
    for (const [x, y] of lights) {
      const reach = Math.max(4, bx - x);
      for (let i = 0; i < reach; i++) {
        a(0.25 * (1 - i / reach));
        p(x + i, Math.round(y - i * ((y - 4) / reach)), 1, 1 + Math.floor(i / 6), "#fff3c4");
      }
    }
    a(1);
  } else {
    const sweeps = [Math.sin(t * 1.3), Math.sin(t * 1.1 + 2)];
    lights.forEach(([x, y], j) => {
      const dir = 0.11 + sweeps[j] * 0.13;
      const len = 28 + j * 2;
      for (let i = 0; i < len; i++) {
        const half = Math.floor(i / 5);
        a(0.28 * (1 - i / len));
        p(x + i, Math.round(y + dir * i) - half, 1, half * 2 + 1, "#fff3c4");
      }
    });
    a(1);
  }
  sign(p, W, "#060c0a", "#2a4a3a", "#cfe6d8");
}

/**
 * OFFSEASON holds the off-season scenes, in the order of rotation. Each name
 * is unique. The loop of Light Cycles depends on the width W of the strip, so
 * its period is the period for W of 460 scene pixels.
 */
export const OFFSEASON: Script[] = [
  { name: "Time Car", period: 14, still: 3, draw: timeCar },
  { name: "Night Highway", period: 60, still: 2, draw: highway },
  { name: "Code Rooftop", period: 12, still: 6.5, draw: rooftop },
  { name: "Starship", period: 16, still: 6, draw: starship },
  { name: "The Gate", period: 20, still: 9.5, draw: gate },
  { name: "Light Cycles", period: (460 + 60) / 70 + 2.5, still: 2.5, draw: lightCycles },
  { name: "Twin Suns", period: 20, still: 6, draw: twinSuns },
  { name: "The Hatch", period: 18, still: 8, draw: hatch },
  { name: "Shadow over Town", period: 18, still: 10, draw: shadowTown },
  { name: "Flashlights in the Woods", period: 16, still: 10, draw: woods },
];

// chalk-web -- 129-20: the seven New Year scenes.
//
// On 31 December and 1 January, the "new-year" key shows one of these scenes.
// In the always-on hours, from 20:00 on 31 December to 05:00 on 1 January, the
// scene rotates through all seven. Six scenes are nods to a film, a series
// episode, or a game, and a person knows each one by one famous moment. The
// seventh scene is a plain fireworks show with no nod. A scene has no title, no
// logo, no show lettering, and no likeness of an actor or of a mascot. A
// character is generic. The only text is the CHALK sign, and the years and
// clock digits where they are the moment. A scene is a Script (strip.ts).
// scene.ts runs these scripts in place of rows for the "new-year" key.

import { disc, rnd, sign, stars, STRIP_H, type Alpha, type Px, type Script } from "./strip";

const H = STRIP_H;

// The digits and the colon, five rows of three pixels each.
const DIGITS: Record<string, string[]> = {
  "0": ["111", "101", "101", "101", "111"],
  "1": ["010", "110", "010", "010", "111"],
  "2": ["111", "001", "111", "100", "111"],
  "3": ["111", "001", "111", "001", "111"],
  "4": ["101", "101", "111", "001", "001"],
  "5": ["111", "100", "111", "001", "111"],
  "6": ["111", "100", "111", "101", "111"],
  "7": ["111", "001", "010", "010", "010"],
  "8": ["111", "101", "111", "101", "111"],
  "9": ["111", "101", "111", "001", "111"],
  ":": ["000", "010", "000", "010", "000"],
};

// Draws text from x, y in the glyphs of DIGITS. Each character takes four
// pixels of width. A character that DIGITS does not have draws nothing.
function digits(p: Px, x: number, y: number, text: string, ink: string): void {
  [...text].forEach((ch, i) =>
    (DIGITS[ch] ?? []).forEach((row, ry) =>
      [...row].forEach((b, rx) => {
        if (b === "1") p(x + i * 4 + rx, y + ry, 1, 1, ink);
      }),
    ),
  );
}

// Draws a firework burst of n sparks around cx, cy, e seconds after it opened.
// The sparks move out at speed, fall, and fade out in 1.6 seconds.
function burst(p: Px, a: Alpha, cx: number, cy: number, e: number, color: string, n: number, speed: number): void {
  a(Math.max(0, 1 - e / 1.6));
  for (let i = 0; i < n; i++) {
    const g = (i / n) * Math.PI * 2;
    const r = e * speed;
    p(Math.round(cx + Math.cos(g) * r), Math.round(cy + Math.sin(g) * r * 0.8 + e * e * 2), 1, 1, i % 3 ? color : "#fff6d8");
  }
  a(1);
}

// A nod to Futurama. A man in a red jacket steps into a tube with a glass door.
// The door closes, frost grows on it, and the year display runs from 1999 to
// 3000. The city outside changes, and the man steps out.
function year3000(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 16;
  const future = u >= 10;
  p(0, 0, W, H, "#0a0d16");
  p(0, 20, W, 4, "#1a1e28");
  p(0, 20, W, 1, "#3a4252");
  const wx = Math.round(W * 0.62);
  const ww = Math.round(W * 0.3);
  p(wx - 1, 3, ww + 2, 15, "#3a4252");
  p(wx, 4, ww, 13, future ? "#0a1a24" : "#0c1020");
  for (let x = 0; x < ww; x++) {
    const seg = Math.floor(x / 4);
    const h = future ? 4 + Math.floor(rnd(seg + 70) * 9) : 2 + Math.floor(rnd(seg + 80) * 5);
    p(wx + x, 17 - h, 1, h, future ? "#1e6a5a" : "#1a2234");
    if (future && x % 4 === 1) p(wx + x, 16 - h, 1, 1, "#8affd8");
  }
  if (future) {
    for (let i = 0; i < 3; i++) {
      const cx = wx + Math.round((t * (8 + i * 5) + i * 20) % ww);
      p(cx, 6 + i * 3, 3, 1, "#c0c8d0");
      p(cx + 3, 6 + i * 3, 1, 1, "#ff6a3a");
    }
  }
  p(wx + Math.round(ww / 2), 4, 1, 13, "#3a4252");
  const cx = Math.round(W * 0.2);
  p(cx - 4, 5, 10, 15, "#2a3442");
  p(cx - 3, 6, 8, 13, "#14202c");
  const frost = u >= 4 && u < 12 ? Math.min(1, (u - 4) / 2) : 0;
  const closed = u >= 3.6 && u < 12;
  const inside = u >= 3 && u < 12.5;
  const chairX = Math.round(W * 0.34);
  const fx = inside ? cx - 1 : Math.round(chairX + (u < 3 ? -(u / 3) * 4 : (u - 12.5) * 6));
  const lean = !inside && u < 3 ? Math.round((u / 3) * 2) : 0;
  p(fx + lean, 10, 3, 2, "#e8b080");
  p(fx + lean, 9, 3, 1, "#d06a2a");
  p(fx - 1 + lean, 12, 5, 4, "#c03030");
  p(fx, 16, 1, 4, "#3a5a8a");
  p(fx + 2, 16, 1, 4, "#3a5a8a");
  if (!inside && u < 3) {
    p(chairX + 4, 15, 4, 1, "#6a4a2a");
    p(chairX + 4, 16, 1, 4, "#6a4a2a");
  }
  a(closed ? 0.55 : 0.15);
  p(cx - 3, 6, 8, 13, "#8ad0ff");
  if (frost) {
    a(0.5 * frost);
    for (let i = 0; i < 20; i++) p(cx - 3 + Math.floor(rnd(i) * 8), 6 + Math.floor(rnd(i + 30) * 13), 1, 1, "#ffffff");
  }
  a(1);
  p(cx - 5, 4, 12, 1, "#5a6a7a");
  p(cx - 5, 19, 12, 1, "#5a6a7a");
  const dx = Math.round(W * 0.38);
  p(dx - 1, 3, 19, 7, "#1a1e24");
  p(dx, 4, 17, 5, "#05080a");
  let year = "1999";
  if (u >= 7 && u < 10) year = String(1999 + Math.floor(((u - 7) / 3) ** 2 * 1001));
  if (future) year = "3000";
  digits(p, dx + 1, 4, year, future ? "#8affd8" : "#ff6a3a");
  sign(p, W, "#0a1420", "#2f6a8a", "#8affd8");
}

// A nod to Ghostbusters II. A green statue with a torch walks across a night
// city in a pink glow, and the street shakes with each step. For the last three
// seconds of the loop the street is empty.
function statue(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 18;
  const walking = u < 15;
  const shake = walking && Math.floor(t * 2.4) % 2 === 0 ? 1 : 0;
  p(0, 0, W, H, "#070a14");
  stars(p, W, 61, Math.floor(W / 12), 10, t);
  for (let x = 0; x < W; x++) {
    const h = 5 + Math.floor(rnd(Math.floor(x / 7) + 90) * 9);
    p(x, 20 - h + shake, 1, h, "#121a2a");
    if (x % 7 > 1 && x % 7 < 6 && x % 2 === 0) {
      for (let y = 21 - h; y < 19; y += 2) if (rnd(x * 3 + y) > 0.55) p(x, y + shake, 1, 1, "#e8c56a");
    }
  }
  p(0, 20, W, 4, "#0e1218");
  p(0, 20, W, 1, "#2a3240");
  for (let x = 4; x < W; x += 9) p(x, 22, 4, 1, "#3a4250");
  if (walking) {
    const sx = Math.round(-12 + (u / 15) * (W + 24));
    a(0.18);
    p(sx - 8, 0, 20, 21, "#ff6ad5");
    a(1);
    const step = Math.floor(t * 2.4) % 2;
    const g = "#5aa894";
    const d = "#3a7a68";
    p(sx, 4, 4, 3, g);
    for (let i = 0; i < 5; i++) p(sx - 1 + i, 3 - (i % 2), 1, 1, g);
    p(sx + 1, 5, 1, 1, d);
    p(sx + 3, 5, 1, 1, d);
    p(sx - 1, 7, 6, 8, g);
    p(sx, 8, 1, 7, d);
    p(sx + 3, 9, 1, 6, d);
    p(sx + 4, 1, 1, 7, g);
    const flame = Math.floor(t * 8) % 2;
    p(sx + 3 + flame, 0, 2, 1, "#ffd23a");
    p(sx + 4, 0, 1, 1, flame ? "#ff9a2a" : "#fff0a0");
    p(sx - 3, 9, 2, 3, g);
    p(sx + step * 2, 15, 2, 5, d);
    p(sx + 3 - step * 2, 15, 2, 5, g);
    for (let i = 0; i < 5; i++) {
      const k = i * 7 + Math.floor(t * 4);
      p(sx - 6 + Math.floor(rnd(k) * 16), 18 + Math.floor(rnd(k + 1) * 2), 1, 1, "#ff6ad5");
    }
  }
  for (let i = 0; i < 6; i++) {
    const x = Math.round(W * 0.1) + i * Math.round(W * 0.15);
    p(x, 18, 1, 2, "#c8d0d8");
    p(x, 17, 1, 1, "#e8c8a8");
  }
  sign(p, W, "#100818", "#8a3a7a", "#ff9ae8");
}

// A nod to The Simpsons. A display on a desk shows 1999, then 2000, then 1900. Then
// the screen fills with noise, a toaster throws toast, a lamp flickers, and a
// television shows static.
function y2k(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 14;
  const crash = u >= 6;
  p(0, 0, W, H, crash && Math.floor(t * 10) % 7 === 0 ? "#141016" : "#1a1410");
  p(0, 20, W, 4, "#2a1c12");
  p(0, 20, W, 1, "#3a281a");
  for (let y = 2; y < 20; y += 4) for (let x = y % 8 ? 2 : 0; x < W; x += 6) p(x, y, 1, 1, "#2a2018");
  const mx = Math.round(W * 0.3);
  p(mx - 2, 15, 24, 2, "#5a3a22");
  p(mx - 1, 17, 1, 3, "#5a3a22");
  p(mx + 20, 17, 1, 3, "#5a3a22");
  p(mx + 2, 4, 16, 11, "#c8c0a8");
  p(mx + 4, 5, 12, 8, crash ? "#0a0a40" : "#0a1a10");
  if (crash) {
    for (let i = 0; i < 20; i++) {
      const k = i + Math.floor(t * 12) * 20;
      p(mx + 4 + Math.floor(rnd(k) * 12), 5 + Math.floor(rnd(k + 1) * 8), 1 + Math.floor(rnd(k + 2) * 3), 1, rnd(k + 3) > 0.5 ? "#ffffff" : "#5a8aff");
    }
  } else if (u >= 5) {
    digits(p, mx + 5, 6, "1900", "#ff4040");
  } else {
    digits(p, mx + 5, 6, u < 4 ? "1999" : "2000", "#7dff8a");
  }
  p(mx + 8, 15, 4, 1, "#a8a090");
  const tvx = Math.round(W * 0.72);
  p(tvx, 9, 14, 11, "#3a3028");
  p(tvx + 1, 10, 10, 8, "#101010");
  if (crash) {
    for (let i = 0; i < 24; i++) {
      const k = i + Math.floor(t * 14) * 30;
      p(tvx + 1 + Math.floor(rnd(k) * 10), 10 + Math.floor(rnd(k + 1) * 8), 1, 1, rnd(k + 2) > 0.5 ? "#e8e8e8" : "#606060");
    }
  } else {
    p(tvx + 2, 12, 8, 4, "#2a4a8a");
  }
  const tx = Math.round(W * 0.56);
  p(tx, 15, 6, 4, "#b8b8c0");
  p(tx + 1, 14, 1, 1, "#303030");
  p(tx + 3, 14, 1, 1, "#303030");
  if (crash) {
    const e = (u - 6) % 2.5;
    p(tx + 1 + Math.round(e * 4), Math.round(14 - e * 10 + e * e * 5), 2, 1, "#d8a050");
    p(tx - 1 - Math.round(e * 3), Math.round(14 - e * 8 + e * e * 5), 2, 1, "#d8a050");
  }
  const lx = Math.round(W * 0.08);
  p(lx, 8, 1, 12, "#14100c");
  p(lx - 3, 5, 7, 3, "#c9a46a");
  if (!crash || Math.floor(t * 9) % 3 === 0) {
    a(0.15);
    p(lx - 6, 8, 13, 12, "#ffd890");
    a(1);
  }
  if (crash) {
    for (let i = 0; i < 6; i++) {
      const k = i + Math.floor(t * 12) * 7;
      if (rnd(k) > 0.5) p(mx + 2 + Math.floor(rnd(k + 1) * 16), 3 + Math.floor(rnd(k + 2) * 3), 1, 1, "#ffe08a");
    }
  }
  if (u >= 6 && u < 6.25) {
    a(0.6);
    p(0, 0, W, H, "#ffffff");
    a(1);
  }
  sign(p, W, "#14100c", "#6a4a2a", "#7dff8a");
}

// A nod to Star Trek: Voyager. A clock in a ring gate shows 23:59 and a
// countdown. At 00:00 the gate lights up and fireworks open inside it.
function midnightGate(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 16;
  const open = u >= 10;
  p(0, 0, W, H, "#060816");
  stars(p, W, 71, Math.floor(W / 10), 14, t);
  for (let x = 0; x < W; x++) {
    const seg = Math.floor(x / 5);
    const h = 2 + Math.floor(rnd(seg + 11) * 6);
    p(x, 18 - h, 1, h, "#141a34");
    if (seg % 4 === 0 && x % 5 === 2) {
      p(x, 15 - h, 1, 3, "#1a2244");
      p(x, 14 - h, 1, 1, "#ff4a4a");
    }
  }
  p(0, 18, W, 6, "#1a1612");
  p(0, 18, W, 1, "#3a3022");
  const gx = Math.round(W * 0.5);
  for (let k = 0; k <= 20; k++) {
    const g = Math.PI * (k / 20);
    const lit = open && (k + Math.floor(t * 10)) % 4 === 0;
    p(Math.round(gx - Math.cos(g) * 18) - 1, Math.round(18 - Math.sin(g) * 14), 3, 2, lit ? "#ffe08a" : "#5a6070");
  }
  p(gx - 19, 17, 3, 2, "#5a6070");
  p(gx + 17, 17, 3, 2, "#5a6070");
  p(gx - 11, 11, 23, 7, "#0a0c14");
  digits(p, gx - 10, 12, open ? "00:00" : "23:59", open ? "#ffe08a" : "#ff4a4a");
  if (!open && u > 0.2) digits(p, gx - 2, 4, String(Math.ceil(10 - u)).slice(-1), "#ff9a4a");
  if (open) {
    const shots: [number, number, number, string][] = [
      [gx - 10, 5, 10, "#ff4a4a"],
      [gx + 12, 4, 10.6, "#4aa3ff"],
      [gx, 2, 11.2, "#ffd23a"],
      [gx - 20, 6, 12, "#40e070"],
      [gx + 22, 6, 12.6, "#ff6ad5"],
    ];
    for (const [x, y, s0, c] of shots) {
      const e = u - s0;
      if (e >= 0 && e <= 1.6) burst(p, a, x, y, e, c, 16, 6);
    }
    a(0.12);
    p(gx - 18, 4, 36, 14, "#ffe08a");
    a(1);
  }
  sign(p, W, "#0a0c1c", "#3a4a8a", "#ffe08a");
}

// A nod to Seinfeld. A card shows 2000, then 2001 after a white flash,
// and a man in a white shirt runs from side to side in a panic.
// Confetti falls the whole time.
function wrongYear(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 15;
  p(0, 0, W, H, "#2a2420");
  for (let x = 0; x < W; x += 8) p(x, 0, 1, 20, "#322a24");
  p(0, 20, W, 4, "#4a3626");
  p(0, 20, W, 1, "#5a4430");
  const dx = Math.round(W * 0.12);
  p(dx, 6, 10, 14, "#5a3a22");
  p(dx + 8, 13, 1, 1, "#d8c050");
  p(dx + 4, 8, 2, 2, "#d8c050");
  const cx = Math.round(W * 0.42);
  p(cx - 1, 4, 19, 10, "#e8e0d0");
  p(cx - 1, 4, 19, 2, "#c83030");
  const flipped = u >= 6;
  if (u >= 6 && u < 6.6) {
    a(0.6);
    p(cx - 1, 6, 19, Math.round(8 * (1 - (u - 6) / 0.6)), "#ffffff");
    a(1);
  } else {
    digits(p, cx + 1, 7, flipped ? "2001" : "2000", flipped ? "#c83030" : "#202020");
  }
  for (let i = 0; i < 8; i++) {
    const k = i * 9;
    p(Math.floor(rnd(k + 2) * W), Math.floor((t * (4 + rnd(k) * 3) + rnd(k + 1) * 20) % 20), 1, 1, ["#ff4a4a", "#ffd23a", "#4aa3ff", "#40e070"][i % 4]);
  }
  const panic = u >= 6.6 && u < 13;
  const mx = Math.round(W * 0.7 + (panic ? Math.sin(t * 7) * W * 0.12 : 0));
  p(mx, 9, 4, 3, "#e0b090");
  p(mx, 8, 4, 1, "#3a2a1a");
  p(mx - 1, 12, 6, 6, "#e8e8e0");
  p(mx - 1, 15, 6, 1, "#c8c8c0");
  p(mx, 18, 2, 2, "#2a3a5a");
  p(mx + 2, 18, 2, 2, "#2a3a5a");
  if (panic) {
    p(mx - 2, 7 + (Math.floor(t * 8) % 2), 1, 4, "#e0b090");
    p(mx + 5, 7 + (Math.floor(t * 8 + 1) % 2), 1, 4, "#e0b090");
    p(mx + 5, 8, 1, 1, "#8ad0ff");
    p(mx - 2, 10, 1, 1, "#8ad0ff");
  } else {
    p(mx - 2, 12, 1, 4, "#e8e8e0");
    p(mx + 5, 12, 1, 4, "#e8e8e0");
    p(mx + 1, 7, 2, 1, "#ffd23a");
    p(mx + 1, 6, 1, 1, "#ff4a4a");
  }
  sign(p, W, "#2a2018", "#8a6a3a", "#ffd23a");
}

// A nod to Fallout, a game. A figure in a blue jumpsuit stands on flat ground under
// a warm-colored sky. A flash opens a cloud that grows, and the figure raises
// an arm with a thumb up against it.
function thumb(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 16;
  ["#2a2a3a", "#4a3a3a", "#7a5038", "#a8703a", "#c89048", "#d8a860"].forEach((c, i) => p(0, i * 3, W, 3, c));
  const cx = Math.round(W * 0.66);
  const grow = u < 2 ? 0 : Math.min(1, (u - 2) / 5);
  if (u >= 2 && u < 2.4) {
    a(1 - (u - 2) / 0.4);
    p(0, 0, W, H, "#fff8e0");
    a(1);
  }
  if (grow > 0) {
    const top = Math.round(17 - grow * 13);
    p(cx - 1, top + 3, 3, Math.max(0, 14 - top), "#8a6a4a");
    disc(p, cx, top + 1, 2 + grow * 4, "#c87a3a");
    disc(p, cx, top, 1 + grow * 3, "#e8a050");
    disc(p, cx - 1, top - 1, grow * 1.5, "#ffe0a0");
    p(cx - Math.round(3 + grow * 6), 16, Math.round(7 + grow * 12), 1, "#8a6a4a");
  }
  for (let x = 0; x < W; x++) {
    const h = Math.round(1 + Math.sin(x * 0.05) * 1.2 + Math.sin(x * 0.17) * 0.8);
    p(x, 17 - h, 1, h + 7, "#6a5038");
  }
  p(0, 20, W, 4, "#4a3828");
  for (let i = 0; i < 3; i++) {
    const x = Math.round(W * 0.12) + i * 7;
    p(x, 13, 1, 4, "#3a2a1c");
    p(x - 1, 13, 1, 1, "#3a2a1c");
    p(x + 1, 14, 1, 1, "#3a2a1c");
  }
  const fx = Math.round(W * 0.42);
  p(fx, 9, 4, 4, "#f0c890");
  p(fx, 8, 4, 1, "#e8c050");
  p(fx + 4, 9, 1, 1, "#e8c050");
  p(fx + 1, 10, 1, 1, u > 4 && Math.floor(t * 2) % 3 === 0 ? "#f0c890" : "#202020");
  p(fx + 3, 10, 1, 1, "#202020");
  p(fx + 1, 12, 2, 1, "#c84a3a");
  p(fx - 1, 13, 6, 6, "#3a6ab8");
  p(fx + 1, 13, 2, 6, "#e8c050");
  p(fx, 19, 2, 1, "#202020");
  p(fx + 3, 19, 2, 1, "#202020");
  const raise = u < 3 ? 0 : Math.min(1, u - 3);
  const ax = fx + 5 + Math.round(raise * 3);
  const ay = Math.round(15 - raise * 7);
  for (let k = 0; k <= 4; k++) p(Math.round(fx + 5 + ((ax - fx - 5) * k) / 4), Math.round(14 + ((ay - 14) * k) / 4), 1, 1, "#3a6ab8");
  p(ax, ay, 2, 2, "#f0c890");
  if (raise >= 1) p(ax + 1, ay - 2, 1, 2, "#f0c890");
  sign(p, W, "#2a2028", "#8a6a3a", "#ffe0a0");
}

// A plain fireworks show over a river and a city. It has no nod. In the last
// four seconds of the loop a finale of ten bursts opens.
function fireworks(p: Px, a: Alpha, W: number, t: number): void {
  const u = t % 14;
  p(0, 0, W, 16, "#05071a");
  stars(p, W, 81, Math.floor(W / 14), 10, t);
  for (let x = 0; x < W; x++) {
    const h = 3 + Math.floor(rnd(Math.floor(x / 6) + 33) * 7);
    p(x, 16 - h, 1, h, "#0e1228");
    if (x % 2 === 0 && rnd(x * 5) > 0.7) p(x, 17 - h + Math.floor(rnd(x) * (h - 1)), 1, 1, "#e8c56a");
  }
  p(0, 16, W, 8, "#070a1c");
  const finale = u > 10;
  const colors = ["#ff4a4a", "#4aa3ff", "#ffd23a", "#40e070", "#ff6ad5", "#ffffff"];
  for (let i = 0; i < (finale ? 10 : 6); i++) {
    const s0 = finale ? 10 + i * 0.25 : i * 1.6 + rnd(i) * 0.6;
    const x = Math.round(W * (0.1 + rnd(i * 3 + (finale ? 50 : 0)) * 0.8));
    const y = 3 + Math.floor(rnd(i * 5) * 5);
    const c = colors[i % 6];
    const e = u - s0;
    if (e < 0) continue;
    if (e < 0.6) {
      p(x, Math.round(16 - (16 - y) * (e / 0.6)), 1, 2, "#ffe0a0");
      continue;
    }
    const b = e - 0.6;
    if (b > 1.6) continue;
    burst(p, a, x, y, b, c, 18, 7);
    a(Math.max(0, 0.4 - b / 4));
    for (let k = 0; k < 6; k++) p(x - 6 + k * 2, 17 + Math.floor(rnd(k + x) * 6), 1, 1, c);
    a(1);
  }
  for (let y = 17; y < H; y += 2) p((Math.floor(t * 6) + y * 7) % W, y, 4, 1, "#141a3a");
  sign(p, W, "#080a1c", "#3a4a8a", "#ffd23a");
}

/**
 * NEWYEAR holds the seven scripts of the "new-year" key, in the order of
 * rotation. Each name is unique.
 */
export const NEWYEAR: Script[] = [
  { name: "Year 3000", period: 16, still: 11, draw: year3000 },
  { name: "The Statue Walks", period: 18, still: 7, draw: statue },
  { name: "Y2K", period: 14, still: 7, draw: y2k },
  { name: "The Gate at Midnight", period: 16, still: 11, draw: midnightGate },
  { name: "The Wrong Year", period: 15, still: 8, draw: wrongYear },
  { name: "Thumb against the Cloud", period: 16, still: 9, draw: thumb },
  { name: "Fireworks over the River", period: 14, still: 11.5, draw: fireworks },
];

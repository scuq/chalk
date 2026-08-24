// chalk-desktop -- rasterize the app icon for the two platforms that will
// not take a PNG: Windows wants an .ico, macOS an .icns. Both formats accept
// PNG-compressed images inside (Vista+ / 10.7+), so the containers are packed
// by hand here -- ~40 lines each, no image library.
//
// Manual tool, not part of the build: outputs are committed next to it and
// only need regenerating when the mark (web/icons/favicon.svg) changes.
//
//   node icons/gen.mjs        (from desktop/; uses the run-chalk skill's
//                              Playwright to render, like web/icons/gen-png.mjs)
//
// The mark's own rounded plate is the icon (purpose "any"); no full-bleed
// variant here because neither platform crops it.

import { chromium } from "../../.claude/skills/run-chalk/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const svgURL =
  "data:image/svg+xml;base64," +
  Buffer.from(readFileSync(new URL("../../web/icons/favicon.svg", import.meta.url))).toString("base64");

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

const browser = await chromium.launch();
const png = new Map();
for (const size of SIZES) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<body style="margin:0;width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center">` +
      `<img src="${svgURL}" width="${size}" height="${size}"></body>`,
  );
  png.set(size, await page.screenshot({ omitBackground: true, type: "png" }));
  await page.close();
}
await browser.close();

// ---- .ico: ICONDIR + ICONDIRENTRY[] + PNG blobs -------------------------
// Sizes up to 256 (the format's ceiling; 256 is encoded as 0). Explorer picks
// the nearest size, so the small ones matter for the taskbar and title bar.
function ico(sizes) {
  const entries = sizes.map((s) => ({ s, data: png.get(s) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(entries.length, 4);
  let offset = 6 + 16 * entries.length;
  const dir = [];
  for (const { s, data } of entries) {
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0);
    e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt8(0, 2); // palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // planes
    e.writeUInt16LE(32, 6); // bpp
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    dir.push(e);
  }
  return Buffer.concat([header, ...dir, ...entries.map((e) => e.data)]);
}

// ---- .icns: "icns" + total length, then (type, length, PNG) chunks -------
// PNG-payload types by size (Apple's table): icp4 16, icp5 32, icp6 64,
// ic07 128, ic08 256, ic09 512, ic10 1024 (the 512@2x slot).
const ICNS_TYPES = [
  [16, "icp4"],
  [32, "icp5"],
  [64, "icp6"],
  [128, "ic07"],
  [256, "ic08"],
  [512, "ic09"],
  [1024, "ic10"],
];
function icns() {
  const chunks = ICNS_TYPES.map(([s, type]) => {
    const data = png.get(s);
    const head = Buffer.alloc(8);
    head.write(type, 0, 4, "ascii");
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const total = 8 + chunks.reduce((n, c) => n + c.length, 0);
  const head = Buffer.alloc(8);
  head.write("icns", 0, 4, "ascii");
  head.writeUInt32BE(total, 4);
  return Buffer.concat([head, ...chunks]);
}

writeFileSync(new URL("icon.ico", import.meta.url), ico([16, 24, 32, 48, 64, 128, 256]));
writeFileSync(new URL("icon.icns", import.meta.url), icns());
writeFileSync(new URL("icon.png", import.meta.url), png.get(512));
console.log("icons/icon.ico, icons/icon.icns, icons/icon.png written");

// Rasterize the PNG app icons from favicon.svg.
//
// Manual tool, not part of `npm run build`: the outputs are committed next
// to it and only need regenerating when the mark changes. PNGs exist at all
// because installable-app icons are the one place SVG isn't enough --
// Chrome wants 192/512 PNGs in the manifest and iOS ignores the manifest
// entirely in favour of <link rel="apple-touch-icon">.
//
// Run from web/ with the e2e suite's chromium (no new dependency here):
//   node icons/gen-png.mjs
//
//   icon-192 / icon-512      purpose "any": the mark's own rounded plate,
//                            transparent outside it.
//   icon-maskable-512        purpose "maskable": full-bleed plate with the
//                            mark at 68% so it survives whatever shape the
//                            launcher crops to (the safe zone is the inner
//                            80% circle).
//   apple-touch-icon (180)   full-bleed; iOS rounds the corners itself and
//                            composites anything transparent onto black.

import { chromium } from "../../test/e2e/node_modules/playwright/index.mjs";
import { readFileSync } from "node:fs";

const svg =
  "data:image/svg+xml;base64," +
  Buffer.from(readFileSync(new URL("favicon.svg", import.meta.url))).toString("base64");

const PLATE = "#080b0d";

const targets = [
  { file: "icon-192.png", size: 192, scale: 1, bleed: false },
  { file: "icon-512.png", size: 512, scale: 1, bleed: false },
  { file: "icon-maskable-512.png", size: 512, scale: 0.68, bleed: true },
  { file: "apple-touch-icon.png", size: 180, scale: 0.82, bleed: true },
];

const browser = await chromium.launch();
for (const { file, size, scale, bleed } of targets) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const art = Math.round(size * scale);
  await page.setContent(
    `<body style="margin:0;width:${size}px;height:${size}px;${bleed ? `background:${PLATE};` : ""}` +
      `display:flex;align-items:center;justify-content:center">` +
      `<img src="${svg}" width="${art}" height="${art}"></body>`,
  );
  await page.screenshot({
    path: new URL(file, import.meta.url).pathname,
    omitBackground: !bleed,
  });
  await page.close();
  console.log(`${file} (${size}px)`);
}
await browser.close();

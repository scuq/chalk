// chalk-desktop -- esbuild driver.
//
// Three bundles, one static page:
//   dist/main.js     the Electron main process (node, cjs)
//   dist/preload.js  the preload for every window (node, cjs -- a sandboxed
//                    preload cannot be ESM)
//   dist/picker.js   the picker page's script (browser, iife)
//   dist/picker.html + picker.css, copied as-is
// plus dist/assets/ for the window icon. Nothing here is content-hashed:
// the files ship inside the app bundle, never through spa.go's immutable
// cache.
//
// 104-1: the desktop shell loads the chalk *server's* page; it embeds no copy
// of web/dist. See docs/phases/PHASE-104-DESKTOP.md for why.

import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, readdirSync } from "node:fs";

const dev = process.env.NODE_ENV !== "production";
const outdir = "dist";
mkdirSync(`${outdir}/assets`, { recursive: true });

const common = {
  bundle: true,
  target: ["es2022"],
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  logLevel: "info",
};

await esbuild.build({
  ...common,
  entryPoints: ["src/main.ts", "src/preload.ts"],
  outdir,
  platform: "node",
  format: "cjs",
  // Electron injects its own module at runtime; bundling it is impossible
  // and unnecessary.
  external: ["electron"],
});

await esbuild.build({
  ...common,
  entryPoints: ["src/picker/picker.ts"],
  outdir,
  platform: "browser",
  format: "iife",
});

for (const f of ["picker.html", "picker.css"]) {
  copyFileSync(`src/picker/${f}`, `${outdir}/${f}`);
}
for (const f of readdirSync("assets")) {
  copyFileSync(`assets/${f}`, `${outdir}/assets/${f}`);
}

console.log("build complete");

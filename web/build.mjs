// chalk-web -- esbuild driver.
//
// Bundles src/index.tsx + theme.css into dist/. The bundle is tiny
// (Preact runtime + our code, < 30 KB) and lives at dist/app.js
// alongside the source-mapped css.
//
// Invoked from go generate via `npm run build`. Watch mode is for
// local development; production builds go through the Dockerfile's
// frontend stage.

import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, existsSync, statSync } from "node:fs";

const watch = process.argv.includes("--watch");
const dev = process.env.NODE_ENV !== "production";

const outdir = "dist";
mkdirSync(outdir, { recursive: true });

// Static assets that the embedded FS needs to serve. We don't bundle
// these; we just copy them so index.html can reference them with
// stable paths under /.
const staticAssets = ["index.html"];
for (const f of staticAssets) {
  if (existsSync(f)) {
    copyFileSync(f, `${outdir}/${f}`);
  }
}

const buildOpts = {
  entryPoints: ["src/index.tsx", "src/theme.css"],
  bundle: true,
  outdir,
  format: "esm",
  target: ["es2022"],
  jsx: "automatic",
  jsxImportSource: "preact",
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  // We want stable filenames so index.html can reference them without
  // a manifest indirection. The runtime fetch happens at the HTML
  // level via <script src="/app.js">.
  entryNames: "[name]",
  // Phase 9.6d: enable code-splitting so dynamic-import() calls
  // produce separate chunk files. The initial index.js bundle drops
  // significantly (~25-30%) because AdminPanel, FriendsPanel,
  // InvitesPanel, and ProfilePanel only load when their UI is opened.
  // Each chunk uses a content-hashed filename for cache-busting.
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  loader: {
    ".woff2": "file",
    ".woff": "file",
    ".ttf": "file",
    ".svg": "file",
    ".png": "file",
  },
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(buildOpts);
  await ctx.watch();
  console.log("watching for changes...");
} else {
  await esbuild.build(buildOpts);
  console.log("build complete");
}


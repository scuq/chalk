// chalk-web -- esbuild driver.
//
// Bundles src/index.tsx + theme.css into dist/ under content-hashed entry
// names (index-XXXX.js / theme-XXXX.css), then rewrites dist/index.html to
// reference them. The server serves index.html no-cache and every hashed
// asset immutably, so a deploy takes effect on the next normal page load
// (no hard refresh) while unchanged chunks stay cached.
//
// Invoked from go generate via `npm run build`. Watch mode is for
// local development; production builds go through the Dockerfile's
// frontend stage.

import * as esbuild from "esbuild";
import {
  copyFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename } from "node:path";

const watch = process.argv.includes("--watch");
const dev = process.env.NODE_ENV !== "production";

const outdir = "dist";
mkdirSync(outdir, { recursive: true });

// 52-2: the MediaPipe runtime for background blur.
//
// These three files cannot be content-hashed INDIVIDUALLY: MediaPipe's
// FilesetResolver builds the URLs itself from a base path we hand it, and the
// WASM loader then fetches its own .wasm relative to that. Their names are
// fixed by the library.
//
// So the DIRECTORY carries the hash instead. That is not cosmetic here --
// spa.go serves everything in dist/ as immutable for a year, on the standing
// promise that a filename identifies its bytes. An unhashed 11 MB WASM would
// be frozen in every browser that ever loaded it, with no way to ship a fix.
// A new build with different bytes gets a new directory and therefore a new
// URL, and the base path is compiled into the bundle (__MEDIAPIPE_BASE__).
//
// Only the SIMD build ships. chalk's support floor (see docs/browser-support.md)
// is well past every engine that shipped WASM SIMD, so the nosimd variant is
// 10 MB of dead weight -- and FilesetResolver only asks for it on a browser we
// already refuse to run on.
const MEDIAPIPE_SRC = [
  ["node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.js", "vision_wasm_internal.js"],
  ["node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm", "vision_wasm_internal.wasm"],
  ["assets/mediapipe/selfie_segmenter.tflite", "selfie_segmenter.tflite"],
];

// emitMediaPipe copies the runtime into dist/mediapipe-<hash>/ and returns the
// base path to compile in. The hash covers every file, so changing the model
// alone still busts the directory.
function emitMediaPipe() {
  const digest = createHash("sha256");
  const bytes = [];
  for (const [src] of MEDIAPIPE_SRC) {
    if (!existsSync(src)) {
      throw new Error(`build: ${src} not found (run npm install)`);
    }
    const b = readFileSync(src);
    digest.update(b);
    bytes.push(b);
  }
  const base = `/mediapipe-${digest.digest("hex").slice(0, 8).toUpperCase()}`;
  mkdirSync(`${outdir}${base}`, { recursive: true });
  MEDIAPIPE_SRC.forEach(([, out], i) => {
    writeFileSync(`${outdir}${base}/${out}`, bytes[i]);
  });
  return base;
}

const mediapipeBase = emitMediaPipe();

const buildOpts = {
  // The blur processor reads this instead of hardcoding a path, so the bundle
  // and the directory it points at are always emitted by the same build.
  define: { __MEDIAPIPE_BASE__: JSON.stringify(mediapipeBase) },
  entryPoints: ["src/index.tsx", "src/theme.css"],
  bundle: true,
  outdir,
  format: "esm",
  target: ["es2022"],
  jsx: "automatic",
  jsxImportSource: "preact",
  minify: !dev,
  sourcemap: dev ? "inline" : false,
  // Content-hash the entry filenames (index-XXXX.js / theme-XXXX.css) so
  // a new bundle gets a new URL. index.html is rewritten below to point at
  // the hashed names, and the server caches every hashed asset immutably
  // (see spa.go). This is what lets a deploy take effect on the next normal
  // page load instead of needing a hard refresh: index.html is no-cache, so
  // the browser always re-reads it, sees the new hashed <script>/<link>,
  // and fetches the new bundle -- while unchanged chunks stay cached.
  entryNames: "[name]-[hash]",
  // Phase 9.6d: enable code-splitting so dynamic-import() calls
  // produce separate chunk files. The initial index bundle drops
  // significantly (~25-30%) because AdminPanel, FriendsPanel,
  // InvitesPanel, and ProfilePanel only load when their UI is opened.
  // Each chunk uses a content-hashed filename for cache-busting.
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  // metafile lets us map the stable entry names (src/index.tsx,
  // src/theme.css) to their hashed output filenames so we can rewrite
  // index.html's references without a separate manifest indirection.
  metafile: true,
  loader: {
    ".woff2": "file",
    ".woff": "file",
    ".ttf": "file",
    ".svg": "file",
    ".png": "file",
    // 102-1: the sound themes (assets/sounds/<theme>/*.wav), imported by
    // notify/theme-assets.ts. Content-hashed like every other file asset.
    ".wav": "file",
  },
  logLevel: "info",
};

// Static assets esbuild never sees: the favicon, the app icons, and the web
// app manifest that lists them. They still need content hashes, because
// spa.go serves everything in dist/ as immutable for a year -- an unhashed
// icon would stay frozen in every browser that has already loaded chalk.
const STATIC_ICONS = [
  "icons/favicon.svg",
  "icons/apple-touch-icon.png",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
];

// A leftover reference to a source name would be served immutable for a
// year under a name whose bytes can change on the next build. Fail the
// build rather than ship it -- typically an icon added to one file but not
// to STATIC_ICONS.
function assertNoUnhashedRefs(text, where) {
  for (const src of [...STATIC_ICONS, "manifest.json"]) {
    if (text.includes(`"/${src}"`)) {
      throw new Error(`build: ${where} still references unhashed /${src}`);
    }
  }
}

function hashedName(src, bytes) {
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8).toUpperCase();
  const dot = src.lastIndexOf(".");
  return `${src.slice(0, dot)}-${hash}${src.slice(dot)}`;
}

// emitStatic copies the icons and the manifest into dist/ under
// content-hashed names, and returns a map of source URL -> hashed URL for
// the callers that reference them. The manifest is emitted last: its icon
// references are rewritten to the hashed names first, so its own hash
// covers them and a changed icon produces a changed manifest.
function emitStatic() {
  const urls = new Map();
  mkdirSync(`${outdir}/icons`, { recursive: true });

  for (const src of STATIC_ICONS) {
    if (!existsSync(src)) {
      throw new Error(`build: ${src} not found in web/ (icons/gen-png.mjs regenerates the PNGs)`);
    }
    const out = hashedName(src, readFileSync(src));
    copyFileSync(src, `${outdir}/${out}`);
    urls.set(`/${src}`, `/${out}`);
  }

  const manifestSrc = "manifest.json";
  if (!existsSync(manifestSrc)) {
    throw new Error("build: manifest.json not found in web/");
  }
  let manifest = readFileSync(manifestSrc, "utf8");
  for (const [from, to] of urls) {
    manifest = manifest.split(`"${from}"`).join(`"${to}"`);
  }
  assertNoUnhashedRefs(manifest, manifestSrc);
  const manifestOut = hashedName(manifestSrc, Buffer.from(manifest));
  writeFileSync(`${outdir}/${manifestOut}`, manifest);
  urls.set(`/${manifestSrc}`, `/${manifestOut}`);

  return urls;
}

// rewriteIndexHTML copies src index.html into dist, replacing the stable
// asset references (/index.js, /theme.css) with the hashed output names
// pulled from the esbuild metafile. Fails loudly if either entry can't be
// resolved -- a silent miss would ship an index.html pointing at a URL that
// no longer exists (blank page on deploy).
function rewriteIndexHTML(metafile) {
  const src = "index.html";
  if (!existsSync(src)) {
    throw new Error("build: index.html not found in web/");
  }
  // Map entryPoint source path -> emitted (hashed) output basename.
  let jsOut = null;
  let cssOut = null;
  for (const [outPath, meta] of Object.entries(metafile.outputs)) {
    const ep = meta.entryPoint;
    if (!ep) continue;
    if (ep === "src/index.tsx") jsOut = basename(outPath);
    else if (ep === "src/theme.css") cssOut = basename(outPath);
  }
  if (!jsOut) throw new Error("build: could not resolve hashed name for src/index.tsx");
  if (!cssOut) throw new Error("build: could not resolve hashed name for src/theme.css");

  let html = readFileSync(src, "utf8");
  // Replace the exact stable references. Guard that each substitution
  // actually matched so a future index.html edit that renames these can't
  // silently ship stale paths.
  const before = html;
  html = html
    .replace('src="/index.js"', `src="/${jsOut}"`)
    .replace('href="/theme.css"', `href="/${cssOut}"`);
  if (html === before || html.includes('src="/index.js"') || html.includes('href="/theme.css"')) {
    throw new Error(
      "build: index.html did not contain the expected /index.js and /theme.css references to rewrite",
    );
  }
  for (const [from, to] of emitStatic()) {
    html = html.split(`"${from}"`).join(`"${to}"`);
  }
  assertNoUnhashedRefs(html, src);
  writeFileSync(`${outdir}/${src}`, html);
}

if (watch) {
  // Watch mode is dev-only; keep hashed names but rewrite index.html on
  // every rebuild so the served HTML always points at the current bundle.
  const ctx = await esbuild.context({
    ...buildOpts,
    plugins: [
      {
        name: "rewrite-index-html",
        setup(build) {
          build.onEnd((result) => {
            if (result.metafile) {
              try {
                rewriteIndexHTML(result.metafile);
              } catch (e) {
                console.error(String(e));
              }
            }
          });
        },
      },
    ],
  });
  await ctx.watch();
  console.log("watching for changes...");
} else {
  const result = await esbuild.build(buildOpts);
  rewriteIndexHTML(result.metafile);
  console.log("build complete");
}


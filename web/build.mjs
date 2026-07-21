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
import { basename } from "node:path";

const watch = process.argv.includes("--watch");
const dev = process.env.NODE_ENV !== "production";

const outdir = "dist";
mkdirSync(outdir, { recursive: true });

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
  },
  logLevel: "info",
};

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


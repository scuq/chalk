// chalk-web -- test runner.
//
// Discovers src/**/*.test.ts, transpiles each to a temp .mjs via
// esbuild (already a build dep, no new packages), then runs them
// under node --test. Zero-config for adding new tests: drop a
// foo.test.ts next to foo.ts and it gets picked up.
//
// Why not `node --test src/**/*.test.ts` directly?
//   - Node 20 (our floor) doesn't strip TS types natively. 22.6+
//     can with --experimental-strip-types, 23.6+ stable, but we
//     don't want to require the bleeding edge.
//   - tsx as a devDep would add ~30 transitive packages. esbuild
//     is already in devDependencies, so reuse it.
//
// Why not vitest?
//   - That's a separate decision, larger than this drop. Punt on it.

import * as esbuild from "esbuild";
import { readdirSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";

const SRC_DIR = "src";
const OUT_DIR = ".test-build";

// Discover *.test.ts under src/. Recursive walk; stays under src.
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) {
      walk(p, out);
    } else if (name.endsWith(".test.ts")) {
      out.push(p);
    }
  }
  return out;
}

const tests = walk(SRC_DIR);
if (tests.length === 0) {
  console.log("no *.test.ts files found under src/");
  process.exit(0);
}
console.log(`found ${tests.length} test file(s):`);
for (const t of tests) console.log(`  - ${t}`);

// Clean build dir.
rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

// Transpile each test to a .mjs file under OUT_DIR, preserving the
// src-relative path so node --test reports useful locations.
const outputs = [];
for (const t of tests) {
  const rel = relative(SRC_DIR, t);
  const out = join(OUT_DIR, rel).replace(/\.ts$/, ".mjs");
  mkdirSync(join(out, ".."), { recursive: true });
  // Bundle so imports of sibling .ts files resolve (e.g.
  // webauthn.test.ts imports from ./webauthn).
  await esbuild.build({
    entryPoints: [t],
    bundle: true,
    outfile: out,
    format: "esm",
    target: ["es2022"],
    platform: "node",
    // Strip Preact-specific imports if a test ever imports a
    // component module: we don't want to drag the JSX runtime
    // into pure-logic tests. Mark preact as external; the test
    // body never executes it because we only test helpers.
    external: ["preact"],
    sourcemap: "inline",
    logLevel: "warning",
  });
  outputs.push(out);
}

// Run node --test on all outputs. Pipe through so the colorized
// reporter output reaches the user.
const res = spawnSync(
  process.execPath,
  ["--test", ...outputs],
  { stdio: "inherit" }
);

process.exit(res.status ?? 1);

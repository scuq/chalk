// chalk-desktop -- test runner. Same shape as web/test.mjs: discover
// src/**/*.test.ts, transpile each with esbuild (already a build dep) into
// .test-build/, run them under node --test.
//
// Only pure logic is tested this way -- link classification, config
// normalisation, permission decisions. Anything that needs a BrowserWindow
// is exercised by hand against the dev stack (checklist in the phase doc).

import * as esbuild from "esbuild";
import { readdirSync, statSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";

const SRC_DIR = "src";
const OUT_DIR = ".test-build";

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith(".test.ts")) out.push(p);
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

rmSync(OUT_DIR, { recursive: true, force: true });
mkdirSync(OUT_DIR, { recursive: true });

const outputs = [];
for (const t of tests) {
  const out = join(OUT_DIR, relative(SRC_DIR, t)).replace(/\.ts$/, ".mjs");
  mkdirSync(join(out, ".."), { recursive: true });
  await esbuild.build({
    entryPoints: [t],
    bundle: true,
    outfile: out,
    format: "esm",
    target: ["es2022"],
    platform: "node",
    // The modules under test never touch Electron at import time; the
    // ones that do are not imported by tests.
    external: ["electron"],
    sourcemap: "inline",
    logLevel: "warning",
  });
  outputs.push(out);
}

const res = spawnSync(process.execPath, ["--test", ...outputs], { stdio: "inherit" });
process.exit(res.status ?? 1);

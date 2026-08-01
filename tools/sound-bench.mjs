// chalk -- the notification-sound tuning bench.
//
//   node tools/sound-bench.mjs      then open the file it prints
//
// Reads the REAL pack out of web/src/notify (esbuild, the same trick the test
// runner uses to load .ts under Node 20) and injects it into
// sound-bench.tmpl.html. Extracting rather than hand-copying is the whole
// point: the bench cannot drift from synth.ts, and re-running this after any
// edit to the table makes the page current again.
//
// The page itself is a faithful port of SoundPlayer.stroke -- what you hear
// there is what chalk plays. It also mirrors every invariant synth.test.ts
// enforces as a live warning under each sound, so a tuning session can't end
// with a red build.
//
// The generated sound-bench.html is git-ignored; this script and the template
// are the sources.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WEB = join(HERE, "..", "web");
const NOTIFY = join(WEB, "src", "notify");
const OUT = join(HERE, "sound-bench.html");

// esbuild is web's devDependency, not a root one, so it needs resolving by
// path rather than by name.
const esbuildEntry = join(WEB, "node_modules", "esbuild", "lib", "main.js");
if (!existsSync(esbuildEntry)) {
  console.error("esbuild not found — run `npm install` in web/ first");
  process.exit(1);
}
const esbuild = await import(pathToFileURL(esbuildEntry).href);

// One entry point re-exporting everything the page needs. types.ts pulls in
// rules.ts for the labels and the category order; nothing in either touches
// the DOM, so bundling them under Node is safe.
const tmp = mkdtempSync(join(tmpdir(), "chalk-bench-"));
const entry = join(tmp, "entry.ts");
const mod = (name) => pathToFileURL(join(NOTIFY, name)).pathname;
writeFileSync(
  entry,
  [
    `export { SOUND_SPECS, ATTACK_MS, RELEASE_MS, MAX_Q, HIGHPASS_HZ, SCREECH_FLOOR_HZ } from ${JSON.stringify(mod("synth.ts"))};`,
    `export { SOUND_CATEGORIES, MACHINE_CATEGORIES, CALL_CATEGORIES, CATEGORY_LABELS } from ${JSON.stringify(mod("types.ts"))};`,
    `export { NOTIFY_EVENT_TYPES } from ${JSON.stringify(mod("rules.ts"))};`,
  ].join("\n"),
);

const bundle = join(tmp, "pack.mjs");
await esbuild.build({
  entryPoints: [entry],
  outfile: bundle,
  bundle: true,
  format: "esm",
  platform: "neutral",
  logLevel: "warning",
});

const p = await import(pathToFileURL(bundle).href);

const isCall = new Set(p.CALL_CATEGORIES);
const pack = {
  specs: p.SOUND_SPECS,
  labels: p.CATEGORY_LABELS,
  order: p.SOUND_CATEGORIES,
  ATTACK_MS: p.ATTACK_MS,
  RELEASE_MS: p.RELEASE_MS,
  MAX_Q: p.MAX_Q,
  HIGHPASS_HZ: p.HIGHPASS_HZ,
  SCREECH_FLOOR_HZ: p.SCREECH_FLOOR_HZ,
  // The page's layout, matching how the settings UI groups the same sounds.
  groups: [
    { title: "notification events — routed by the rules engine", categories: p.NOTIFY_EVENT_TYPES },
    { title: "the call roster", categories: p.CALL_CATEGORIES },
    { title: "chalk's own noises", categories: p.MACHINE_CATEGORIES.filter((c) => !isCall.has(c)) },
  ],
};

const html = readFileSync(join(HERE, "sound-bench.tmpl.html"), "utf8").replace(
  "__PACK_JSON__",
  JSON.stringify(pack),
);
writeFileSync(OUT, html);

console.log(`${pack.order.length} categories → ${OUT}`);
console.log(pathToFileURL(OUT).href);

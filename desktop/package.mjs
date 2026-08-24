// chalk-desktop -- packaging driver (104-4).
//
// Turns dist/ + package.json into a runnable app directory under out/ with
// @electron/packager: out/chalk-<platform>-<arch>/ holding chalk.exe,
// chalk.app or chalk. The release workflow archives those directories per
// platform; nothing here zips, signs or uploads.
//
//   node package.mjs [--platform win32|darwin|linux] [--arch x64|arm64]
//
// Defaults to the host. Cross-arch on the same OS always works (packager
// downloads that arch's Electron); cross-platform works too except for
// macOS signing, which 104-4 does not do anyway. Windows exe metadata and
// the icon are applied with resedit (pure JS) -- no wine.

import { packager } from "@electron/packager";
import { readFileSync } from "node:fs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const platform = opt("platform", process.platform);
const arch = opt("arch", process.arch);

const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));
if (!/^\d+\.\d+\.\d+/.test(pkg.version)) {
  throw new Error(`package.json version "${pkg.version}" is not a release version; run npm version first`);
}

const paths = await packager({
  dir: ".",
  out: "out",
  name: "chalk",
  executableName: "chalk",
  platform,
  arch,
  overwrite: true,
  asar: true,
  prune: true,
  // packager appends .ico / .icns per platform; Linux takes no icon here
  // (BrowserWindow sets it, --install-desktop-entry writes the .desktop file).
  icon: "icons/icon",
  appBundleId: "org.chalk.desktop",
  appCategoryType: "public.app-category.social-networking",
  darwinDarkModeSupport: true,
  win32metadata: {
    CompanyName: "chalk",
    ProductName: "chalk",
    FileDescription: "chalk",
    InternalName: "chalk",
    OriginalFilename: "chalk.exe",
  },
  // Only dist/, assets/ and package.json ship. Everything else is source or
  // tooling; node_modules is pruned to dependencies (there are none).
  ignore: [
    /^\/src($|\/)/,
    /^\/icons($|\/)/,
    /^\/out($|\/)/,
    /^\/\.test-build($|\/)/,
    /^\/(build|test|package)\.mjs$/,
    /^\/tsconfig\.json$/,
    /^\/package-lock\.json$/,
  ],
});

for (const p of paths) console.log(`packaged: ${p}`);

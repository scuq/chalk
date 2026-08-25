// 105-2: the updater core against a fake release on disk -- a real tar.gz,
// real sums, a real signature from a throwaway key, a fetch stub that
// serves them by URL. Needs `tar` on PATH (every supported platform has it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  cleanupOldVersions,
  hoistSingleDir,
  installRoot,
  parseVersionDir,
  prepareUpdate,
  versionDirName,
} from "./updater";
import { sha256Hex } from "./verify";

const BASE = "https://github.com/scuq/chalk/releases/download";
const VERSION = "9.9.9";
const PLATFORM = "linux";
const ARCH = "x64";
const ARCHIVE = `chalk-desktop-${VERSION}-linux-${ARCH}.tar.gz`;

async function fakeRelease(tamper: "none" | "archive" | "signature" = "none") {
  const work = mkdtempSync(join(tmpdir(), "chalk-rel-"));
  const appDir = join(work, `chalk-linux-${ARCH}`);
  mkdirSync(appDir);
  writeFileSync(join(appDir, "chalk"), "#!/bin/sh\necho fake chalk\n", { mode: 0o755 });
  mkdirSync(join(appDir, "resources"));
  writeFileSync(join(appDir, "resources", "app.asar"), "not really");
  // Relative paths and cwd: GNU tar on a Windows runner reads "C:\\…" as
  // host:path (the very bug 0.8.3's Windows build failed on).
  execFileSync("tar", ["-czf", ARCHIVE, `chalk-linux-${ARCH}`], { cwd: work });
  let archive = new Uint8Array(readFileSync(join(work, ARCHIVE))) as Uint8Array<ArrayBuffer>;
  const sumsText = `${await sha256Hex(archive)}  ${ARCHIVE}\n`;
  if (tamper === "archive") archive = new Uint8Array([...archive, 0]) as Uint8Array<ArrayBuffer>;
  const sums = new TextEncoder().encode(sumsText) as Uint8Array<ArrayBuffer>;
  const key = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey)) as Uint8Array<ArrayBuffer>;
  let sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, sums)) as Uint8Array<ArrayBuffer>;
  if (tamper === "signature") sig = new Uint8Array(sig.map((b, i) => (i === 3 ? b ^ 1 : b))) as Uint8Array<ArrayBuffer>;
  const files = new Map<string, Uint8Array>([
    [`${BASE}/v${VERSION}/SHA256SUMS.desktop`, sums],
    [`${BASE}/v${VERSION}/SHA256SUMS.desktop.ed25519`, sig],
    [`${BASE}/v${VERSION}/${ARCHIVE}`, archive],
  ]);
  const fetched: string[] = [];
  const fetchStub = (async (input: string | URL | Request) => {
    const url = String(input);
    fetched.push(url);
    const body = files.get(url);
    if (!body) return new Response(null, { status: 404 });
    return new Response(body as unknown as BodyInit, { status: 200, headers: { "content-length": String(body.length) } });
  }) as typeof fetch;
  return { pub, fetchStub, fetched, work };
}

function fakeInstall() {
  const root = mkdtempSync(join(tmpdir(), "chalk-root-"));
  const running = join(root, "chalk-1.0.0");
  mkdirSync(running);
  writeFileSync(join(running, "chalk"), "#!/bin/sh\n", { mode: 0o755 });
  return { root, execPath: join(running, "chalk"), running };
}

test("names", () => {
  assert.equal(versionDirName("v1.2.3"), "chalk-1.2.3");
  assert.equal(parseVersionDir("chalk-1.2.3"), "1.2.3");
  assert.equal(parseVersionDir("chalk-1.2.3.partial"), null);
  assert.equal(parseVersionDir("chalk-linux-x64"), null);
});

test("installRoot prefers the running dir's parent, falls back, or gives up", () => {
  const { root, execPath } = fakeInstall();
  assert.equal(installRoot(execPath, join(root, "fallback")), root);
  // /usr/lib exists and is not writable by a user: the parent is refused,
  // the fallback is used; an unwritable fallback gives up.
  assert.equal(installRoot("/usr/lib/chalk-1.0.0/chalk", join(root, "fb")), join(root, "fb"));
  assert.equal(installRoot("/usr/lib/chalk-1.0.0/chalk", "/usr/lib/chalk-fb"), null);
});

test("prepareUpdate: fetches, verifies, unpacks beside the running version, marks ready", async () => {
  const rel = await fakeRelease();
  const inst = fakeInstall();
  const r = await prepareUpdate(VERSION, {
    platform: PLATFORM, arch: ARCH, execPath: inst.execPath, fallbackRoot: join(inst.root, "fb"),
    publicKey: rel.pub, fetch: rel.fetchStub, downloadBase: BASE,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.dir, join(inst.root, "chalk-9.9.9"));
  assert.equal(readFileSync(join(r.dir, ".ready"), "utf8"), "9.9.9\n");
  assert.ok(existsSync(join(r.dir, "resources", "app.asar")), "hoisted out of the tar's top dir");
  // NTFS has no execute bit; Windows runs chalk.exe regardless.
  if (process.platform !== "win32") assert.ok(statSync(r.exe).mode & 0o111, "exe bit kept");
  assert.equal(existsSync(join(inst.root, ".download-9.9.9")), false, "download removed");
  assert.equal(existsSync(join(inst.root, "chalk-9.9.9.partial")), false);
  assert.deepEqual(rel.fetched.map((u) => u.split("/").pop()), ["SHA256SUMS.desktop", "SHA256SUMS.desktop.ed25519", ARCHIVE]);

  // Idempotent: a second call returns the ready dir without fetching.
  rel.fetched.length = 0;
  const again = await prepareUpdate(VERSION, {
    platform: PLATFORM, arch: ARCH, execPath: inst.execPath, fallbackRoot: join(inst.root, "fb"),
    publicKey: rel.pub, fetch: rel.fetchStub, downloadBase: BASE,
  });
  assert.equal(again.ok, true);
  assert.equal(rel.fetched.length, 0);
});

test("prepareUpdate refuses a tampered archive and leaves nothing behind", async () => {
  const rel = await fakeRelease("archive");
  const inst = fakeInstall();
  const r = await prepareUpdate(VERSION, {
    platform: PLATFORM, arch: ARCH, execPath: inst.execPath, fallbackRoot: join(inst.root, "fb"),
    publicKey: rel.pub, fetch: rel.fetchStub, downloadBase: BASE,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.stage, "download");
  assert.equal(existsSync(join(inst.root, "chalk-9.9.9")), false);
  assert.equal(existsSync(join(inst.root, ".download-9.9.9")), false);
});

test("prepareUpdate refuses a bad signature before downloading anything", async () => {
  const rel = await fakeRelease("signature");
  const inst = fakeInstall();
  const r = await prepareUpdate(VERSION, {
    platform: PLATFORM, arch: ARCH, execPath: inst.execPath, fallbackRoot: join(inst.root, "fb"),
    publicKey: rel.pub, fetch: rel.fetchStub, downloadBase: BASE,
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.stage, "sums");
  assert.ok(!rel.fetched.some((u) => u.endsWith(ARCHIVE)), "archive never requested");
});

test("prepareUpdate: no key, wrong platform", async () => {
  const rel = await fakeRelease();
  const inst = fakeInstall();
  const noKey = await prepareUpdate(VERSION, {
    platform: PLATFORM, arch: ARCH, execPath: inst.execPath, fallbackRoot: join(inst.root, "fb"),
    publicKey: null, fetch: rel.fetchStub, downloadBase: BASE,
  });
  assert.equal(noKey.ok, false);
  const mac = await prepareUpdate(VERSION, {
    platform: "darwin", arch: ARCH, execPath: inst.execPath, fallbackRoot: join(inst.root, "fb"),
    publicKey: rel.pub, fetch: rel.fetchStub, downloadBase: BASE,
  });
  assert.equal(mac.ok, false);
  assert.equal(rel.fetched.length, 0);
});

test("hoistSingleDir only hoists a lone directory", () => {
  const d = mkdtempSync(join(tmpdir(), "chalk-hoist-"));
  mkdirSync(join(d, "top"));
  writeFileSync(join(d, "top", "a"), "a");
  hoistSingleDir(d);
  assert.ok(existsSync(join(d, "a")));
  assert.equal(existsSync(join(d, "top")), false);
  const e = mkdtempSync(join(tmpdir(), "chalk-hoist-"));
  writeFileSync(join(e, "chalk.exe"), "x");
  mkdirSync(join(e, "resources"));
  hoistSingleDir(e);
  assert.ok(existsSync(join(e, "chalk.exe")) && existsSync(join(e, "resources")));
});

test("cleanupOldVersions removes older versions and leftovers only", () => {
  const root = mkdtempSync(join(tmpdir(), "chalk-clean-"));
  for (const n of ["chalk-1.0.0", "chalk-1.1.0", "chalk-1.2.0", "chalk-2.0.0", "chalk-1.1.5.partial", ".download-1.1.5", "chalk-linux-x64", "notes"]) {
    mkdirSync(join(root, n));
  }
  const removed = cleanupOldVersions(root, "1.2.0", join(root, "chalk-1.2.0")).sort();
  // 105-5: the highest older version (1.1.0) stays as the rollback target.
  assert.deepEqual(removed, [".download-1.1.5", "chalk-1.0.0", "chalk-1.1.5.partial"]);
  for (const n of ["chalk-1.1.0", "chalk-1.2.0", "chalk-2.0.0", "chalk-linux-x64", "notes"]) assert.ok(existsSync(join(root, n)), n);
  // A rejected (rolled-back-from) version goes even though it is newer; with
  // keepPrevious off the older one goes too.
  const r2 = cleanupOldVersions(root, "1.2.0", join(root, "chalk-1.2.0"), { rejected: "2.0.0", keepPrevious: false }).sort();
  assert.deepEqual(r2, ["chalk-1.1.0", "chalk-2.0.0"]);
});

// ---- 105-3: the macOS bundle swap, driven on any OS with an injected
// extractor (the real one is ditto; the layout logic is what is under test).

import { execFileSync as _exec } from "node:child_process";
import { activateMacBundle, bundleOf, findPrepared, previousVersion, rollbackMacBundle, runningDir } from "./updater";

const MAC_ARCHIVE = `chalk-desktop-${VERSION}-macos-${ARCH}.zip`;

async function fakeMacRelease() {
  const work = mkdtempSync(join(tmpdir(), "chalk-mac-rel-"));
  mkdirSync(join(work, "chalk.app", "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(work, "chalk.app", "Contents", "MacOS", "chalk"), "#!/bin/sh\necho fake\n", { mode: 0o755 });
  writeFileSync(join(work, "chalk.app", "Contents", "Info.plist"), "<plist/>");
  mkdirSync(join(work, "__MACOSX"));
  writeFileSync(join(work, "__MACOSX", "._junk"), "x");
  // A tar.gz served under the zip's name; the injected extractor untars it.
  _exec("tar", ["-czf", MAC_ARCHIVE, "chalk.app", "__MACOSX"], { cwd: work });
  let archive = new Uint8Array(readFileSync(join(work, MAC_ARCHIVE))) as Uint8Array<ArrayBuffer>;
  const sums = new TextEncoder().encode(`${await sha256Hex(archive)}  ${MAC_ARCHIVE}\n`) as Uint8Array<ArrayBuffer>;
  const key = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", key.publicKey)) as Uint8Array<ArrayBuffer>;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, key.privateKey, sums)) as Uint8Array<ArrayBuffer>;
  const files = new Map<string, Uint8Array>([
    [`${BASE}/v${VERSION}/SHA256SUMS.desktop`, sums],
    [`${BASE}/v${VERSION}/SHA256SUMS.desktop.ed25519`, sig],
    [`${BASE}/v${VERSION}/${MAC_ARCHIVE}`, archive],
  ]);
  const fetchStub = (async (input: string | URL | Request) => {
    const body = files.get(String(input));
    if (!body) return new Response(null, { status: 404 });
    return new Response(body as unknown as BodyInit, { status: 200, headers: { "content-length": String(body.length) } });
  }) as typeof fetch;
  return { pub, fetchStub };
}

function fakeMacInstall() {
  const root = mkdtempSync(join(tmpdir(), "chalk-mac-root-"));
  const bundle = join(root, "chalk.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(bundle, "Contents", "MacOS", "chalk"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(bundle, "Contents", "old-marker"), "1.0.0");
  return { root, bundle, execPath: join(bundle, "Contents", "MacOS", "chalk") };
}

test("bundleOf / runningDir see the .app on macOS and the dir elsewhere", () => {
  assert.equal(bundleOf("/Applications/chalk.app/Contents/MacOS/chalk"), "/Applications/chalk.app");
  assert.equal(bundleOf("/opt/chalk-1.0.0/chalk"), null);
  assert.equal(runningDir("/Applications/chalk.app/Contents/MacOS/chalk", "darwin"), "/Applications/chalk.app");
  assert.equal(runningDir("/opt/chalk-1.0.0/chalk", "linux"), "/opt/chalk-1.0.0");
});

test("macOS: prepareUpdate unpacks to chalk.app.next with the marker outside the bundle", async () => {
  const rel = await fakeMacRelease();
  const inst = fakeMacInstall();
  const extract = async (archive: string, dest: string) => {
    _exec("tar", ["-xf", relative(dest, archive)], { cwd: dest });
  };
  const r = await prepareUpdate(VERSION, {
    platform: "darwin", arch: ARCH, execPath: inst.execPath, fallbackRoot: join(inst.root, "fb"),
    publicKey: rel.pub, fetch: rel.fetchStub, downloadBase: BASE, extract,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.dir, join(inst.root, "chalk.app.next"));
  assert.ok(existsSync(join(r.dir, "Contents", "Info.plist")));
  assert.equal(existsSync(join(r.dir, ".ready")), false, "no marker inside the bundle");
  assert.equal(readFileSync(join(inst.root, ".chalk-next"), "utf8"), "9.9.9\n");
  assert.equal(existsSync(join(inst.root, "chalk.app.partial")), false);
  assert.equal(existsSync(join(inst.root, "__MACOSX")), false);
  assert.ok(existsSync(join(inst.bundle, "Contents", "old-marker")), "the running bundle is untouched");

  // Activation swaps at the same path and keeps the old one for rollback.
  const live = activateMacBundle(inst.root);
  assert.equal(live, inst.bundle);
  assert.ok(existsSync(join(live, "Contents", "Info.plist")), "new bundle at the live path");
  assert.ok(existsSync(join(inst.root, "chalk.app.old", "Contents", "old-marker")), "old bundle kept");
  assert.equal(existsSync(join(inst.root, ".chalk-next")), false);
  assert.equal(existsSync(join(inst.root, "chalk.app.next")), false);

  // Next start: the old bundle stays as the rollback target (105-5) …
  assert.deepEqual(cleanupOldVersions(inst.root, VERSION, live), []);
  assert.ok(existsSync(join(inst.root, "chalk.app.old")));
  // … and rollback swaps it back, leaving the rejected one for cleanup.
  const prev = previousVersion(inst.root, VERSION, "darwin");
  assert.ok(prev && prev.dir === join(inst.root, "chalk.app.old"));
  assert.equal(rollbackMacBundle(inst.root), live);
  assert.ok(existsSync(join(live, "Contents", "old-marker")), "old bundle is live again");
  assert.ok(existsSync(join(inst.root, "chalk.app.rejected", "Contents", "Info.plist")));
  assert.deepEqual(cleanupOldVersions(inst.root, "1.0.0", live), ["chalk.app.rejected"]);
});

test("macOS: not running from a bundle is unsupported; a stale .next is cleaned", () => {
  const root = mkdtempSync(join(tmpdir(), "chalk-mac-clean-"));
  mkdirSync(join(root, "chalk.app.next"));
  writeFileSync(join(root, ".chalk-next"), "1.0.0\n");
  mkdirSync(join(root, "chalk.app"));
  const removed = cleanupOldVersions(root, "1.2.0", join(root, "chalk.app")).sort();
  assert.deepEqual(removed, [".chalk-next", "chalk.app.next"]);
  const root2 = mkdtempSync(join(tmpdir(), "chalk-mac-clean-"));
  mkdirSync(join(root2, "chalk.app.next"));
  writeFileSync(join(root2, ".chalk-next"), "2.0.0\n");
  assert.deepEqual(cleanupOldVersions(root2, "1.2.0", join(root2, "chalk.app")), [], "a newer prepared bundle stays");
});

test("macOS: unsupported when not in a bundle", async () => {
  const rel = await fakeMacRelease();
  const r = await prepareUpdate(VERSION, {
    platform: "darwin", arch: ARCH, execPath: "/opt/chalk-1.0.0/chalk", fallbackRoot: mkdtempSync(join(tmpdir(), "fb-")),
    publicKey: rel.pub, fetch: rel.fetchStub, downloadBase: BASE,
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.stage, "unsupported");
});

// ---- 105-5: a prepared update survives a quit; rollback has a target ------

test("findPrepared picks the newest ready version dir, ignores unready or older ones", () => {
  const root = mkdtempSync(join(tmpdir(), "chalk-fp-"));
  for (const [v, ready, exe] of [["1.1.0", true, true], ["1.3.0", true, true], ["1.4.0", false, true], ["1.5.0", true, false], ["1.2.5", true, true]] as const) {
    mkdirSync(join(root, `chalk-${v}`));
    if (ready) writeFileSync(join(root, `chalk-${v}`, ".ready"), `${v}\n`);
    if (exe) writeFileSync(join(root, `chalk-${v}`, "chalk"), "x");
  }
  const p = findPrepared(root, "1.2.0", "linux");
  assert.ok(p);
  assert.equal(p.version, "1.3.0");
  assert.equal(findPrepared(root, "1.3.0", "linux"), null);
  const mroot = mkdtempSync(join(tmpdir(), "chalk-fp-mac-"));
  mkdirSync(join(mroot, "chalk.app.next", "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(mroot, "chalk.app.next", "Contents", "MacOS", "chalk"), "x");
  writeFileSync(join(mroot, ".chalk-next"), "2.0.0\n");
  assert.equal(findPrepared(mroot, "1.0.0", "darwin")?.version, "2.0.0");
  assert.equal(findPrepared(mroot, "2.0.0", "darwin"), null);
});

test("previousVersion is the highest older dir with an executable", () => {
  const root = mkdtempSync(join(tmpdir(), "chalk-pv-"));
  for (const [v, exe] of [["1.0.0", true], ["1.1.0", false], ["1.2.0", true], ["2.0.0", true]] as const) {
    mkdirSync(join(root, `chalk-${v}`));
    if (exe) writeFileSync(join(root, `chalk-${v}`, "chalk"), "x");
  }
  assert.equal(previousVersion(root, "1.3.0", "linux")?.version, "1.2.0");
  assert.equal(previousVersion(root, "1.2.0", "linux")?.version, "1.0.0");
  assert.equal(previousVersion(root, "1.0.0", "linux"), null);
});

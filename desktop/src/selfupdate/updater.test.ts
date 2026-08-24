// 105-2: the updater core against a fake release on disk -- a real tar.gz,
// real sums, a real signature from a throwaway key, a fetch stub that
// serves them by URL. Needs `tar` on PATH (every supported platform has it).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  execFileSync("tar", ["-czf", join(work, ARCHIVE), "-C", work, `chalk-linux-${ARCH}`]);
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
  assert.ok(statSync(r.exe).mode & 0o111, "exe bit kept");
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
  assert.deepEqual(removed, [".download-1.1.5", "chalk-1.0.0", "chalk-1.1.0", "chalk-1.1.5.partial"]);
  for (const n of ["chalk-1.2.0", "chalk-2.0.0", "chalk-linux-x64", "notes"]) assert.ok(existsSync(join(root, n)), n);
});

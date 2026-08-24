// chalk-desktop -- the self-updater's core (105-2 / 105-4): fetch, verify,
// unpack beside the running version, mark ready. No Electron in this file --
// everything platform-ish is a parameter -- so the whole flow runs under
// node:test against a fake release (updater.test.ts).
//
// Layout it produces (docs/phases/PHASE-105-SELFUPDATE.md):
//
//   <root>/chalk-0.9.0/…            the running version (or whatever dir the
//                                   zip was unpacked to, on the first install)
//   <root>/chalk-0.9.1.partial/     while unpacking
//   <root>/chalk-0.9.1/  + .ready   verified and complete; apply.ts restarts
//                                   into it
//   <root>/.download-0.9.1          the archive while it is fetched/verified
//
// macOS (105-3) is the exception to versioned directories: a Dock pin and
// LaunchServices know the bundle by PATH, so `chalk.app` is replaced at the
// same path -- unpacked as `<root>/chalk.app.next` (readiness in
// `<root>/.chalk-next`, never inside the bundle: adding a file there breaks
// its code seal), swapped by activateMacBundle at restart (running →
// `chalk.app.old`, `.next` → `chalk.app`), `.old` removed next start.
//
// Nothing is ever written into the running version's directory, and the
// running version is never deleted by its own process: cleanupOldVersions
// runs at the NEXT start, from the new version, and removes only
// `chalk-<lower semver>` siblings (or `chalk.app.old`) plus leftovers.
//
// Order of checks (verify.ts): signed sums first, then the archive's hash,
// then the unpack; a failure at any point leaves nothing behind but a log
// line and the caller falls back to "download it yourself".

import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { expectedArchive, verifyArchive, verifySums } from "./verify";

export const RELEASE_DOWNLOAD = "https://github.com/scuq/chalk/releases/download";
/** A desktop archive is ~110–190 MB compressed; anything past this is not ours. */
export const MAX_ARCHIVE_BYTES = 600 * 1024 * 1024;
export const MAX_SUMS_BYTES = 64 * 1024;

export interface UpdateEnv {
  platform: string;
  arch: string;
  /** Where the running app lives; the install root is derived from it. */
  execPath: string;
  /** Fallback root when the running app's parent is not writable. */
  fallbackRoot: string;
  /** The pinned release key; null refuses everything. */
  publicKey: Uint8Array<ArrayBuffer> | null;
  fetch: typeof fetch;
  /** Base URL of release assets; the test points it at fakes. */
  downloadBase?: string;
  /** The tar executable; "tar" on every supported platform. */
  tar?: string;
  /** Override the extractor (tests). Default: `ditto -x -k` on darwin,
   * `tar -xf` elsewhere -- both are part of the OS. */
  extract?: (archive: string, dest: string) => Promise<void>;
  log?: (line: string) => void;
}

export type Prepared =
  | { ok: true; version: string; dir: string; exe: string }
  | { ok: false; stage: "unsupported" | "sums" | "download" | "unpack"; reason: string };

export function exeName(platform: string): string {
  return platform === "win32" ? "chalk.exe" : "chalk";
}

export function versionDirName(version: string): string {
  return `chalk-${version.replace(/^v/, "")}`;
}

/** parseVersionDir reads "chalk-1.2.3" back into "1.2.3"; null otherwise. */
export function parseVersionDir(name: string): string | null {
  const m = /^chalk-(\d+\.\d+\.\d+)$/.exec(name);
  return m ? m[1] : null;
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

function writable(dir: string): boolean {
  try {
    // Only ever create one level: the install root's parent must already
    // exist. (Also sidesteps a Node mkdirp spin on filesystems like procfs
    // that answer ENOENT for a child whose parent exists.)
    if (!existsSync(dir)) {
      if (!existsSync(dirname(dir))) return false;
      mkdirSync(dir, { recursive: false });
    }
    const probe = mkdtempSync(join(dir, ".w-"));
    rmSync(probe, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/** bundleOf finds the `.app` the executable lives in (macOS), or null. */
export function bundleOf(execPath: string): string | null {
  let p = dirname(execPath);
  for (let i = 0; i < 4; i++) {
    if (p.endsWith(".app")) return p;
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  return null;
}

/** runningDir is what the updater treats as "the running version": the
 * `.app` bundle on macOS, the executable's directory elsewhere. */
export function runningDir(execPath: string, platform: string): string {
  if (platform === "darwin") {
    const b = bundleOf(execPath);
    if (b) return b;
  }
  return dirname(execPath);
}

/**
 * installRoot is the directory new versions go into: the parent of the
 * running version when writable (the user unpacked the zip somewhere of
 * their own, so that is where they expect chalk to live), else the fallback
 * under userData. null when neither can be written.
 */
export function installRoot(execPath: string, fallbackRoot: string, platform: string = process.platform): string | null {
  const running = runningDir(execPath, platform);
  const parent = dirname(running);
  if (parent !== running && writable(parent)) return parent;
  if (writable(fallbackRoot)) return fallbackRoot;
  return null;
}

export const MAC_BUNDLE = "chalk.app";
const MAC_NEXT_MARKER = ".chalk-next";

function assetURL(base: string, version: string, name: string): string {
  return `${base}/v${version}/${name}`;
}

function isReleaseURL(u: string, base: string): boolean {
  try {
    const url = new URL(u);
    const b = new URL(base);
    return url.protocol === b.protocol && url.host === b.host && url.pathname.startsWith(b.pathname);
  } catch {
    return false;
  }
}

/** fetchSmall reads a whole response (the sums and its signature) under a cap. */
export async function fetchSmall(
  fetchFn: typeof fetch,
  url: string,
  max: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const res = await fetchFn(url, { redirect: "follow" });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > max) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length <= max ? buf : null;
  } catch {
    return null;
  }
}

/** downloadTo streams a response to a file, refusing past `max` bytes. */
export async function downloadTo(
  fetchFn: typeof fetch,
  url: string,
  path: string,
  max: number,
): Promise<boolean> {
  try {
    const res = await fetchFn(url, { redirect: "follow" });
    if (!res.ok || !res.body) return false;
    const len = Number(res.headers.get("content-length") ?? "0");
    if (len > max) return false;
    let seen = 0;
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new Error("archive larger than allowed"));
        else controller.enqueue(chunk);
      },
    });
    // DOM and node:stream/web declare ReadableStream separately; the value is
    // the same object at runtime.
    const web = res.body.pipeThrough(counter) as unknown as import("node:stream/web").ReadableStream;
    await pipeline(Readable.fromWeb(web), createWriteStream(path));
    return true;
  } catch {
    rmSync(path, { force: true });
    return false;
  }
}

function run(cmd: string, argv: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr?.on("data", (d) => (err += String(d)));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.trim()}`))));
  });
}

function defaultExtract(platform: string, tar: string): (archive: string, dest: string) => Promise<void> {
  // ditto restores a bundle exactly (symlinks, modes, the resource fork
  // sequestering of a ditto-made zip); bsdtar/GNU tar for the rest.
  if (platform === "darwin") return (archive, dest) => run("ditto", ["-x", "-k", archive, dest]);
  return (archive, dest) => run(tar, ["-xf", archive, "-C", dest]);
}

/** hoistSingleDir: a Linux tar.gz carries one top-level directory, a Windows
 * zip does not. Normalise to "the app's files are directly in `dir`". */
export function hoistSingleDir(dir: string): void {
  const entries = readdirSync(dir);
  if (entries.length !== 1) return;
  const only = join(dir, entries[0]);
  if (!statSync(only).isDirectory()) return;
  for (const name of readdirSync(only)) renameSync(join(only, name), join(dir, name));
  rmSync(only, { recursive: true, force: true });
}

/**
 * prepareUpdate does everything short of restarting. Idempotent: an
 * already-ready version dir is returned without re-downloading.
 */
export async function prepareUpdate(version: string, env: UpdateEnv): Promise<Prepared> {
  const log = env.log ?? (() => {});
  const v = version.replace(/^v/, "");
  const base = env.downloadBase ?? RELEASE_DOWNLOAD;
  if (env.platform !== "win32" && env.platform !== "linux" && env.platform !== "darwin") {
    return { ok: false, stage: "unsupported", reason: `no in-place update on ${env.platform}` };
  }
  if (env.platform === "darwin" && !bundleOf(env.execPath)) {
    return { ok: false, stage: "unsupported", reason: "not running from a .app bundle" };
  }
  if (!env.publicKey) return { ok: false, stage: "unsupported", reason: "no release key pinned" };
  const name = expectedArchive(v, env.platform, env.arch);
  if (!name) return { ok: false, stage: "unsupported", reason: `no archive for ${env.platform}/${env.arch}` };
  const root = installRoot(env.execPath, env.fallbackRoot, env.platform);
  if (!root) return { ok: false, stage: "unsupported", reason: "nowhere writable to install" };
  const mac = env.platform === "darwin";

  const finalDir = mac ? join(root, `${MAC_BUNDLE}.next`) : join(root, versionDirName(v));
  const exe = mac ? join(finalDir, "Contents", "MacOS", "chalk") : join(finalDir, exeName(env.platform));
  const readyMarker = mac ? join(root, MAC_NEXT_MARKER) : join(finalDir, ".ready");
  const isReady = () => {
    try {
      return existsSync(exe) && readFileSync(readyMarker, "utf8").trim() === v;
    } catch {
      return false;
    }
  };
  if (isReady()) return { ok: true, version: v, dir: finalDir, exe };

  // 1. Signed sums.
  const sumsURL = assetURL(base, v, "SHA256SUMS.desktop");
  const sigURL = assetURL(base, v, "SHA256SUMS.desktop.ed25519");
  if (!isReleaseURL(sumsURL, base)) return { ok: false, stage: "sums", reason: "bad release URL" };
  const sums = await fetchSmall(env.fetch, sumsURL, MAX_SUMS_BYTES);
  const sig = await fetchSmall(env.fetch, sigURL, 256);
  if (!sums || !sig) return { ok: false, stage: "sums", reason: "sums or signature not fetched" };
  const table = await verifySums(sums, sig, env.publicKey);
  if (!table) return { ok: false, stage: "sums", reason: "sums signature did not verify" };
  if (!table.has(name)) return { ok: false, stage: "sums", reason: `${name} not in the signed sums` };

  // 2. The archive, hashed against the signed table.
  const download = join(root, `.download-${v}`);
  rmSync(download, { force: true });
  if (!(await downloadTo(env.fetch, assetURL(base, v, name), download, MAX_ARCHIVE_BYTES))) {
    return { ok: false, stage: "download", reason: "archive not fetched" };
  }
  const bytes = new Uint8Array(readFileSync(download)) as Uint8Array<ArrayBuffer>;
  const verified = await verifyArchive(table, v, env.platform, env.arch, bytes);
  if (!verified) {
    rmSync(download, { force: true });
    return { ok: false, stage: "download", reason: "archive hash did not match the signed sums" };
  }
  log(`verified ${name} (${bytes.length} bytes)`);

  // 3. Unpack beside the running version, then mark ready.
  const partial = mac ? join(root, `${MAC_BUNDLE}.partial`) : `${finalDir}.partial`;
  const extract = env.extract ?? defaultExtract(env.platform, env.tar ?? "tar");
  rmSync(partial, { recursive: true, force: true });
  rmSync(finalDir, { recursive: true, force: true });
  rmSync(readyMarker, { force: true });
  mkdirSync(partial, { recursive: true });
  try {
    await extract(download, partial);
    if (mac) {
      // The zip holds `chalk.app/…` (ditto --keepParent); a `__MACOSX/`
      // sidecar may ride along and is dropped.
      rmSync(join(partial, "__MACOSX"), { recursive: true, force: true });
      const bundle = join(partial, MAC_BUNDLE);
      if (!existsSync(join(bundle, "Contents", "MacOS", "chalk"))) {
        throw new Error(`${MAC_BUNDLE}/Contents/MacOS/chalk missing after unpack`);
      }
      renameSync(bundle, finalDir);
      rmSync(partial, { recursive: true, force: true });
    } else {
      hoistSingleDir(partial);
      if (!existsSync(join(partial, exeName(env.platform)))) {
        throw new Error(`${exeName(env.platform)} missing after unpack`);
      }
      renameSync(partial, finalDir);
    }
    writeFileSync(readyMarker, `${v}\n`);
  } catch (e) {
    rmSync(partial, { recursive: true, force: true });
    rmSync(finalDir, { recursive: true, force: true });
    rmSync(readyMarker, { force: true });
    return { ok: false, stage: "unpack", reason: String(e) };
  } finally {
    rmSync(download, { force: true });
  }
  log(`ready: ${finalDir}`);
  return { ok: true, version: v, dir: finalDir, exe };
}

/**
 * activateMacBundle swaps the prepared bundle into place: the running
 * `chalk.app` becomes `chalk.app.old` (the process keeps running -- macOS
 * moves a live bundle without complaint), `chalk.app.next` becomes
 * `chalk.app`. Returns the new bundle's path; throws if either rename
 * fails, in which case nothing has been lost (the first rename is undone).
 */
export function activateMacBundle(root: string): string {
  const live = join(root, MAC_BUNDLE);
  const next = join(root, `${MAC_BUNDLE}.next`);
  const old = join(root, `${MAC_BUNDLE}.old`);
  if (!existsSync(join(next, "Contents", "MacOS", "chalk"))) throw new Error("no prepared bundle");
  rmSync(old, { recursive: true, force: true });
  const hadLive = existsSync(live);
  if (hadLive) renameSync(live, old);
  try {
    renameSync(next, live);
  } catch (e) {
    if (hadLive) renameSync(old, live);
    throw e;
  }
  rmSync(join(root, MAC_NEXT_MARKER), { force: true });
  return live;
}

/**
 * cleanupOldVersions runs at start, from the version now running: removes
 * `chalk-<semver>` siblings older than `currentVersion` and any leftover
 * `.partial` / `.download-*`. Never the running directory, never a name it
 * does not recognise (the first zip's `chalk-linux-x64/` stays; the README
 * says so). Returns what it removed.
 */
export function cleanupOldVersions(root: string, currentVersion: string, running: string): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return removed;
  }
  // A prepared-but-never-activated macOS bundle is stale once the running
  // version is at or past it.
  let staleNext = false;
  try {
    const nextV = readFileSync(join(root, MAC_NEXT_MARKER), "utf8").trim();
    staleNext = /^\d+\.\d+\.\d+$/.test(nextV) && cmpVersion(nextV, currentVersion) <= 0;
  } catch {
    // no marker
  }
  for (const name of entries) {
    const full = join(root, name);
    if (full === running) continue;
    const ver = parseVersionDir(name);
    const stale =
      (ver !== null && cmpVersion(ver, currentVersion) < 0) ||
      /^chalk-\d+\.\d+\.\d+\.partial$/.test(name) ||
      /^\.download-/.test(name) ||
      name === `${MAC_BUNDLE}.old` ||
      name === `${MAC_BUNDLE}.partial` ||
      (staleNext && (name === `${MAC_BUNDLE}.next` || name === MAC_NEXT_MARKER));
    if (!stale) continue;
    try {
      rmSync(full, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Still in use by a process that has not exited yet; next start.
    }
  }
  return removed;
}

// chalk-desktop -- what the self-updater checks before it touches a byte
// (105-1). Pure functions plus WebCrypto; no network, no filesystem.
//
// The chain, in the order the updater must run it:
//
//   1. SHA256SUMS.desktop  +  SHA256SUMS.desktop.ed25519  →  verifySums()
//      The signature is over the exact bytes of the sums file, Ed25519, with
//      the key pinned in key.ts. No key pinned = refused.
//   2. the archive for THIS platform/arch and the announced version must be
//      listed in the sums → expectedArchive() + entry lookup
//   3. the downloaded archive's SHA-256 must equal that entry → verifyArchive()
//
// Every function here fails closed: a malformed sums file, a wrong length, an
// unknown platform, a missing entry -- all "not verified", never "probably
// fine". The caller degrades to "download it yourself".

import { RELEASE_PUBLIC_KEY_HEX } from "./key";

export type Platform = "win32" | "darwin" | "linux";
export type Arch = "x64" | "arm64";

/** expectedArchive is the release asset name for a version on a platform,
 * the same rule release.yml's Archive steps follow. */
export function expectedArchive(version: string, platform: string, arch: string): string | null {
  const v = version.replace(/^v/, "");
  if (!/^\d+\.\d+\.\d+$/.test(v)) return null;
  if (arch !== "x64" && arch !== "arm64") return null;
  switch (platform) {
    case "win32":
      return `chalk-desktop-${v}-windows-${arch}.zip`;
    case "darwin":
      return `chalk-desktop-${v}-macos-${arch}.zip`;
    case "linux":
      return `chalk-desktop-${v}-linux-${arch}.tar.gz`;
    default:
      return null;
  }
}

/** parseSums reads `sha256sum` output: "<64 hex>  <name>" per line. Names
 * with a path separator or a leading "*" (binary marker) are refused; the
 * file is ours and never has either. Duplicates refuse the whole file. */
export function parseSums(text: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const m = /^([0-9a-f]{64})  ([^\s/\\*][^\s/\\]*)$/.exec(line);
    if (!m) return null;
    if (out.has(m[2])) return null;
    out.set(m[2], m[1]);
  }
  return out.size > 0 ? out : null;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** releaseKey returns the pinned public key, or null when none is pinned. */
export function releaseKey(hex: string = RELEASE_PUBLIC_KEY_HEX): Uint8Array<ArrayBuffer> | null {
  const b = hexToBytes(hex);
  return b && b.length === 32 ? b : null;
}

/**
 * verifySums checks the Ed25519 signature over the sums file's bytes and, on
 * success, returns the parsed table. Returns null for: no key, a signature
 * that is not 64 bytes, a signature that does not verify, a sums file that
 * does not parse. Uses WebCrypto (Node's in the main process).
 */
export async function verifySums(
  sumsBytes: Uint8Array<ArrayBuffer>,
  signature: Uint8Array<ArrayBuffer>,
  publicKey: Uint8Array<ArrayBuffer> | null,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<Map<string, string> | null> {
  if (!publicKey || publicKey.length !== 32) return null;
  if (signature.length !== 64) return null;
  let ok = false;
  try {
    const key = await subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    ok = await subtle.verify({ name: "Ed25519" }, key, signature, sumsBytes);
  } catch {
    return null;
  }
  if (!ok) return null;
  return parseSums(new TextDecoder().decode(sumsBytes));
}

/** sha256Hex of a downloaded archive. */
export async function sha256Hex(
  bytes: Uint8Array<ArrayBuffer>,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<string> {
  return bytesToHex(new Uint8Array(await subtle.digest("SHA-256", bytes)));
}

/**
 * verifyArchive is step 3: the archive named for this version/platform must
 * be in the verified table and its hash must match. Returns the archive name
 * on success, null otherwise.
 */
export async function verifyArchive(
  sums: Map<string, string>,
  version: string,
  platform: string,
  arch: string,
  archive: Uint8Array<ArrayBuffer>,
  subtle: SubtleCrypto = crypto.subtle,
): Promise<string | null> {
  const name = expectedArchive(version, platform, arch);
  if (!name) return null;
  const want = sums.get(name);
  if (!want) return null;
  const got = await sha256Hex(archive, subtle);
  // Same length by construction (64 hex each); a plain compare is fine here,
  // there is no secret on either side.
  return got === want ? name : null;
}

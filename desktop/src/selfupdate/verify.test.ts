// 105-1: the verifier against a throwaway key generated here. The real key
// is pinned in key.ts; these tests never read it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bytesToHex,
  expectedArchive,
  hexToBytes,
  parseSums,
  releaseKey,
  sha256Hex,
  verifyArchive,
  verifySums,
} from "./verify";

const enc = (s: string) => new TextEncoder().encode(s) as Uint8Array<ArrayBuffer>;

async function keypair() {
  const k = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", k.publicKey)) as Uint8Array<ArrayBuffer>;
  const sign = async (m: Uint8Array<ArrayBuffer>) =>
    new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, k.privateKey, m)) as Uint8Array<ArrayBuffer>;
  return { pub, sign };
}

const archive = enc("pretend this is a zip");
const ARCHIVE_SHA = await sha256Hex(archive);
const SUMS = `${ARCHIVE_SHA}  chalk-desktop-0.9.1-linux-arm64.tar.gz\n${"ab".repeat(32)}  chalk-desktop-0.9.1-windows-x64.zip\n`;

test("expectedArchive follows the release naming", () => {
  assert.equal(expectedArchive("v0.9.1", "win32", "x64"), "chalk-desktop-0.9.1-windows-x64.zip");
  assert.equal(expectedArchive("0.9.1", "darwin", "arm64"), "chalk-desktop-0.9.1-macos-arm64.zip");
  assert.equal(expectedArchive("0.9.1", "linux", "arm64"), "chalk-desktop-0.9.1-linux-arm64.tar.gz");
  assert.equal(expectedArchive("0.9.1-rc1", "linux", "x64"), null);
  assert.equal(expectedArchive("0.9.1", "freebsd", "x64"), null);
  assert.equal(expectedArchive("0.9.1", "linux", "ia32"), null);
});

test("parseSums accepts sha256sum output and refuses anything odd", () => {
  const t = parseSums(SUMS);
  assert.ok(t);
  assert.equal(t.get("chalk-desktop-0.9.1-linux-arm64.tar.gz"), ARCHIVE_SHA);
  assert.equal(parseSums(""), null);
  assert.equal(parseSums("nothex  file\n"), null);
  assert.equal(parseSums(`${"a".repeat(64)}  ../escape\n`), null);
  assert.equal(parseSums(`${"a".repeat(64)}  *binary\n`), null);
  assert.equal(parseSums(`${"a".repeat(64)}  a\n${"b".repeat(64)}  a\n`), null, "duplicate name");
  assert.equal(parseSums(`${"a".repeat(64)} single-space\n`), null);
});

test("hex helpers", () => {
  assert.deepEqual(hexToBytes("00ff"), new Uint8Array([0, 255]));
  assert.equal(hexToBytes("0"), null);
  assert.equal(hexToBytes("zz"), null);
  assert.equal(bytesToHex(new Uint8Array([0, 255, 16])), "00ff10");
  assert.equal(releaseKey(""), null);
  assert.equal(releaseKey("ab"), null);
  assert.ok(releaseKey("ab".repeat(32)));
});

test("verifySums: a good signature yields the table", async () => {
  const { pub, sign } = await keypair();
  const sums = enc(SUMS);
  const table = await verifySums(sums, await sign(sums), pub);
  assert.ok(table);
  assert.equal(table.size, 2);
});

test("verifySums refuses: no key, wrong key, bad length, tampered file, garbage file", async () => {
  const a = await keypair();
  const b = await keypair();
  const sums = enc(SUMS);
  const sig = await a.sign(sums);
  assert.equal(await verifySums(sums, sig, null), null, "no key pinned");
  assert.equal(await verifySums(sums, sig, b.pub), null, "wrong key");
  assert.equal(await verifySums(sums, sig.subarray(0, 63) as Uint8Array<ArrayBuffer>, a.pub), null, "short sig");
  const tampered = enc(SUMS.replace("linux", "linux2"));
  assert.equal(await verifySums(tampered, sig, a.pub), null, "tampered sums");
  const garbage = enc("not a sums file");
  assert.equal(await verifySums(garbage, await a.sign(garbage), a.pub), null, "signed garbage still refused");
});

test("verifyArchive: matching hash and name, else null", async () => {
  const table = parseSums(SUMS)!;
  assert.equal(await verifyArchive(table, "0.9.1", "linux", "arm64", archive), "chalk-desktop-0.9.1-linux-arm64.tar.gz");
  assert.equal(await verifyArchive(table, "0.9.2", "linux", "arm64", archive), null, "version not listed");
  assert.equal(await verifyArchive(table, "0.9.1", "darwin", "arm64", archive), null, "platform not listed");
  assert.equal(await verifyArchive(table, "0.9.1", "windows", "x64", archive), null, "unknown platform string");
  const flipped = enc("pretend this is a zip!");
  assert.equal(await verifyArchive(table, "0.9.1", "linux", "arm64", flipped), null, "one byte off");
});

// Interop vector: produced on 2026-08-25 by tools/make-release-key.sh and the
// exact command the release workflow runs,
//   openssl pkeyutl -sign -inkey chalk-release.key -rawin -in SHA256SUMS.desktop
// with a throwaway key. Pins that OpenSSL's raw Ed25519 output is what
// WebCrypto verifies -- the one thing a unit test with a generated key
// cannot show.
test("interop: an openssl pkeyutl -rawin signature verifies", async () => {
  const pub = hexToBytes("526e6c81113f5273ae156883b0d1b087691f54c192f6a25e2801c6ab88d5f6f7")!;
  const sig = hexToBytes(
    "0ea004b6be4440b26f172303679bd2adb49d517aac186f22c7f2bba453b7a7b9ea11fde5bb022176fdba8b4d76ab3a372817fa3ae3b68068de442d56a6e1f602",
  )!;
  const sums = new Uint8Array(
    Buffer.from(
      "NzY3YjkxZTliYzEzOGViYjJmZGQ3YWExNDdhZGUwODVkMGMyNTc0MDRkMWFiYzgzY2U4ODYxZmM4ZjZhODhlYiAgY2hhbGstZGVza3RvcC0wLjkuMS1saW51eC1hcm02NC50YXIuZ3oKNzM4NjAyZjFkYmMxZmY0MzY3YTU2YzMyNzJkMDQ5YWE3M2EwOWQ0NDI1OTEyYzFkZjMyM2FiMzcxNjk3ZDEzNSAgY2hhbGstZGVza3RvcC0wLjkuMS13aW5kb3dzLXg2NC56aXAK",
      "base64",
    ),
  ) as Uint8Array<ArrayBuffer>;
  const table = await verifySums(sums, sig, pub);
  assert.ok(table, "openssl signature must verify under WebCrypto");
  assert.equal(table.get("chalk-desktop-0.9.1-linux-arm64.tar.gz"), "767b91e9bc138ebb2fdd7aa147ade085d0c257404d1abc83ce8861fc8f6a88eb");
  sums[0] ^= 1;
  assert.equal(await verifySums(sums, sig, pub), null, "a flipped byte in the sums fails");
});

// The pinned release key (key.ts) verifies a sums file signed with the real
// private key on 2026-08-25 -- the same file RELEASE_SIGN_KEY_B64 was set
// from. If this fails after a key rotation, key.ts and the secret disagree.
test("the pinned release key matches the signing key", async () => {
  const { RELEASE_PUBLIC_KEY_HEX } = await import("./key");
  const pub = releaseKey(RELEASE_PUBLIC_KEY_HEX);
  assert.ok(pub, "no release key pinned");
  const sig = hexToBytes("02aab25b7dcfa6dc2c2b3a173efb5d7dfc37d62a73470bf4d72a90170495b43bbfd29ea4343ca60dbf8254842bc0bae5dc6a46ddd3e55a91fa4fac63adbaf20f")!;
  const sums = new Uint8Array(Buffer.from("ODVhNThkZTJjZTlkY2E4YjBmODcyYzMyNWZmNjg0N2E1M2NiYmZmYzE1MjljZTA1MTZiNjNkNWY4YmRjMGUwYiAgY2hhbGstZGVza3RvcC0wLjAuMC1saW51eC14NjQudGFyLmd6Cg==", "base64")) as Uint8Array<ArrayBuffer>;
  const table = await verifySums(sums, sig, pub);
  assert.ok(table, "the pinned key does not verify a signature from signing/chalk-release.key");
  assert.equal(table.size, 1);
});

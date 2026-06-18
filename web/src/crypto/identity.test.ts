// Tests for src/crypto/identity.ts. Validated against independent Node
// implementations (crypto.hkdfSync + X25519/Ed25519 KeyObject) at authoring
// time; these tests assert the cryptographic properties that matter:
// determinism (recovery depends on it), self-signature integrity, and
// X25519 key-agreement usability.
//
// Run via `node test.mjs` from web/. The runner bundles via esbuild and
// executes under node --test (same WebCrypto API as the browser).

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  deriveIdentity,
  deriveIdentityFromMnemonic,
  verifyIdentitySelfSig,
} from "./identity";

function hexToBytes(h: string): Uint8Array {
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16);
  return o;
}
function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// A fixed 64-byte seed (shape of a BIP-39 mnemonicToSeed output).
const SEED_A = hexToBytes(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f" +
    "202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f",
);
const SEED_B = hexToBytes("ff".repeat(64));

test("deriveIdentity is deterministic (same seed -> same identity)", async () => {
  const a = await deriveIdentity(SEED_A);
  const b = await deriveIdentity(SEED_A);
  assert.equal(bytesToHex(a.x25519Public), bytesToHex(b.x25519Public));
  assert.equal(bytesToHex(a.ed25519Public), bytesToHex(b.ed25519Public));
  assert.equal(bytesToHex(a.selfSig), bytesToHex(b.selfSig));
});

test("derived public keys and self-sig have correct lengths", async () => {
  const a = await deriveIdentity(SEED_A);
  assert.equal(a.x25519Public.length, 32);
  assert.equal(a.ed25519Public.length, 32);
  assert.equal(a.selfSig.length, 64);
  assert.equal(a.generation, 1);
});

test("private keys are non-extractable", async () => {
  const a = await deriveIdentity(SEED_A);
  assert.equal(a.x25519Private.extractable, false);
  assert.equal(a.ed25519Private.extractable, false);
});

test("self-signature verifies for a genuine identity", async () => {
  const a = await deriveIdentity(SEED_A);
  assert.equal(await verifyIdentitySelfSig(a.x25519Public, a.ed25519Public, a.selfSig), true);
});

test("self-signature is rejected when the x25519 key is tampered", async () => {
  const a = await deriveIdentity(SEED_A);
  const tampered = a.x25519Public.slice();
  tampered[0] ^= 1;
  assert.equal(await verifyIdentitySelfSig(tampered, a.ed25519Public, a.selfSig), false);
});

test("self-signature is rejected under a different ed25519 key", async () => {
  const a = await deriveIdentity(SEED_A);
  const b = await deriveIdentity(SEED_B);
  assert.equal(await verifyIdentitySelfSig(a.x25519Public, b.ed25519Public, a.selfSig), false);
});

test("verifyIdentitySelfSig returns false on malformed input (never throws)", async () => {
  assert.equal(await verifyIdentitySelfSig(new Uint8Array(31), new Uint8Array(32), new Uint8Array(64)), false);
  assert.equal(await verifyIdentitySelfSig(new Uint8Array(32), new Uint8Array(32), new Uint8Array(10)), false);
});

test("two identities agree on an ECDH shared secret (both directions)", async () => {
  const a = await deriveIdentity(SEED_A);
  const b = await deriveIdentity(SEED_B);
  const importPub = (raw: Uint8Array) =>
    crypto.subtle.importKey("raw", raw, { name: "X25519" }, false, []);
  const s1 = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "X25519", public: await importPub(b.x25519Public) }, a.x25519Private, 256),
  );
  const s2 = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "X25519", public: await importPub(a.x25519Public) }, b.x25519Private, 256),
  );
  assert.equal(bytesToHex(s1), bytesToHex(s2));
});

test("different seeds produce different identities", async () => {
  const a = await deriveIdentity(SEED_A);
  const b = await deriveIdentity(SEED_B);
  assert.notEqual(bytesToHex(a.x25519Public), bytesToHex(b.x25519Public));
  assert.notEqual(bytesToHex(a.ed25519Public), bytesToHex(b.ed25519Public));
});

test("the ed25519 private key actually signs (usable, not just stored)", async () => {
  const a = await deriveIdentity(SEED_A);
  const msg = new TextEncoder().encode("chalk message");
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, a.ed25519Private, msg));
  const verifyKey = await crypto.subtle.importKey(
    "jwk",
    { kty: "OKP", crv: "Ed25519", x: btoa(String.fromCharCode(...a.ed25519Public)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") },
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  assert.equal(await crypto.subtle.verify({ name: "Ed25519" }, verifyKey, sig, msg), true);
});

test("deriveIdentity rejects a wrong-length seed", async () => {
  await assert.rejects(() => deriveIdentity(new Uint8Array(32)));
});

test("deriveIdentityFromMnemonic matches deriveIdentity on the same seed", async () => {
  // abandon x11 + about is the canonical all-zero-entropy mnemonic.
  const mnemonic =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const fromMnemonic = await deriveIdentityFromMnemonic(mnemonic);
  // Independently seed + derive to confirm the two paths agree.
  const { mnemonicToSeed } = await import("./bip39");
  const seed = await mnemonicToSeed(mnemonic);
  const fromSeed = await deriveIdentity(seed);
  assert.equal(bytesToHex(fromMnemonic.x25519Public), bytesToHex(fromSeed.x25519Public));
  assert.equal(bytesToHex(fromMnemonic.ed25519Public), bytesToHex(fromSeed.ed25519Public));
});

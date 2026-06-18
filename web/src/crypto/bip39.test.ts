// Tests for src/crypto/bip39.ts. Validated against the canonical
// Trezor BIP-39 vectors (entropy<->mnemonic + checksum). Seeds here use
// chalk's EMPTY passphrase (not Trezor's "TREZOR"), cross-checked against
// an independent PBKDF2 (Python hashlib) at authoring time.
//
// Run via `node test.mjs` from web/.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  entropyToMnemonic,
  mnemonicToEntropy,
  validateMnemonic,
  mnemonicToSeed,
  generateMnemonic,
} from "./bip39";

function hexToBytes(h: string): Uint8Array {
  const o = new Uint8Array(h.length / 2);
  for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16);
  return o;
}
function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// [entropyHex, mnemonic, emptyPassphraseSeedHex]
const VECTORS: [string, string, string][] = [
  [
    "0000000000000000000000000000000000000000000000000000000000000000",
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art",
    "408b285c123836004f4b8842c89324c1f01382450c0d439af345ba7fc49acf705489c6fc77dbd4e3dc1dd8cc6bc9f043db8ada1e243c4a0eafb290d399480840",
  ],
  [
    "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
    "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title",
    "761914478ebf6fe16185749372e91549361af22b386de46322cf8b1ba7e92e80c4af05196f742be1e63aab603899842ddadf4e7248d8e43870a4b6ff9bf16324",
  ],
  [
    "8080808080808080808080808080808080808080808080808080808080808080",
    "letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless",
    "848bbe19cad445e46f35fd3d1a89463583ac2b60b5eb4cfcf955731775a5d9e17a81a71613fed83f1ae27b408478fdec2bbc75b5161d1937aa7cdf4ad686ef5f",
  ],
  [
    "00000000000000000000000000000000",
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
    "5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4",
  ],
  [
    "7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f",
    "legal winner thank year wave sausage worth useful legal winner thank yellow",
    "878386efb78845b3355bd15ea4d39ef97d179cb712b77d5c12b6be415fffeffe5f377ba02bf3f8544ab800b955e51fbff09828f682052a20faa6addbbddfb096",
  ],
];

test("entropy -> mnemonic matches BIP-39 vectors", async () => {
  for (const [entHex, mnem] of VECTORS) {
    assert.equal(await entropyToMnemonic(hexToBytes(entHex)), mnem);
  }
});

test("mnemonic -> entropy round-trips", async () => {
  for (const [entHex, mnem] of VECTORS) {
    assert.equal(bytesToHex(await mnemonicToEntropy(mnem)), entHex);
  }
});

test("mnemonic -> seed (empty passphrase) matches independent PBKDF2", async () => {
  for (const [, mnem, seedHex] of VECTORS) {
    assert.equal(bytesToHex(await mnemonicToSeed(mnem)), seedHex);
  }
});

test("validateMnemonic accepts valid phrases", async () => {
  for (const [, mnem] of VECTORS) {
    assert.equal(await validateMnemonic(mnem), true);
  }
});

test("validateMnemonic rejects a tampered word (checksum)", async () => {
  const [, mnem] = VECTORS[0];
  const words = mnem.split(" ");
  words[words.length - 1] = words[words.length - 1] === "about" ? "abandon" : "about";
  assert.equal(await validateMnemonic(words.join(" ")), false);
});

test("validateMnemonic rejects an unknown word", async () => {
  assert.equal(await validateMnemonic(Array(24).fill("notaword").join(" ")), false);
});

test("validateMnemonic rejects wrong word count", async () => {
  assert.equal(await validateMnemonic("abandon abandon abandon"), false);
});

test("generateMnemonic produces a valid 24-word phrase", async () => {
  const m = await generateMnemonic();
  assert.equal(m.split(" ").length, 24);
  assert.equal(await validateMnemonic(m), true);
});

test("two generated mnemonics differ (entropy is random)", async () => {
  assert.notEqual(await generateMnemonic(), await generateMnemonic());
});

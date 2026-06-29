// Tests for src/crypto/identity-setup.ts (the testable logic behind the
// identity-setup screen). Run via `node test.mjs` from web/.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  pickChallengeIndices,
  checkChallenge,
  verifyEnteredPhrase,
} from "./identity-setup";
import { deriveIdentityFromMnemonic } from "./identity";

const MNEMONIC =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// 12 words is a valid BIP-39 phrase for the challenge-logic tests (the
// challenge logic is length-agnostic); identity tests use a real 24-word.
const MNEMONIC_24 =
  "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";

test("pickChallengeIndices returns the requested count of distinct, in-range indices", () => {
  for (let trial = 0; trial < 50; trial++) {
    const idx = pickChallengeIndices(3, 24);
    assert.equal(idx.length, 3);
    assert.equal(new Set(idx).size, 3);
    for (const i of idx) {
      assert.ok(i >= 0 && i < 24);
    }
    // sorted ascending
    assert.deepEqual(idx, [...idx].sort((a, b) => a - b));
  }
});

test("pickChallengeIndices throws if count > total", () => {
  assert.throws(() => pickChallengeIndices(25, 24));
});

test("checkChallenge accepts correct answers (case/whitespace-insensitive)", () => {
  const words = MNEMONIC.split(" ");
  const answers = new Map<number, string>([
    [0, words[0].toUpperCase()],
    [5, `  ${words[5]} `],
    [11, words[11]],
  ]);
  assert.equal(checkChallenge(MNEMONIC, answers), true);
});

test("checkChallenge rejects a single wrong word", () => {
  const answers = new Map<number, string>([
    [0, "abandon"],
    [5, "wrong"],
    [11, "about"],
  ]);
  assert.equal(checkChallenge(MNEMONIC, answers), false);
});

test("checkChallenge rejects an empty answer set", () => {
  assert.equal(checkChallenge(MNEMONIC, new Map()), false);
});

test("checkChallenge rejects out-of-range indices", () => {
  assert.equal(checkChallenge(MNEMONIC, new Map([[99, "abandon"]])), false);
});

test("verifyEnteredPhrase returns the identity when the phrase matches the published key", async () => {
  const expected = await deriveIdentityFromMnemonic(MNEMONIC_24);
  const got = await verifyEnteredPhrase(MNEMONIC_24, expected.x25519Public);
  assert.notEqual(got, null);
  assert.deepEqual([...got!.x25519Public], [...expected.x25519Public]);
});

test("verifyEnteredPhrase returns null for a valid but different phrase", async () => {
  const expected = await deriveIdentityFromMnemonic(MNEMONIC_24);
  // a different valid 24-word phrase derives a different identity
  const other =
    "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo vote";
  const got = await verifyEnteredPhrase(other, expected.x25519Public);
  assert.equal(got, null);
});

test("verifyEnteredPhrase returns null for an invalid phrase (bad checksum)", async () => {
  const expected = await deriveIdentityFromMnemonic(MNEMONIC_24);
  const bad = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon";
  const got = await verifyEnteredPhrase(bad, expected.x25519Public);
  assert.equal(got, null);
});

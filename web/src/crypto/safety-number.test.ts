// Tests for crypto/safety-number.ts (out-of-band verification) + the idb
// verification store. The derivation is security-critical: both parties MUST
// compute byte-identical codes, and any key change MUST be detectable.

import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  computeSafetyNumber,
  verificationState,
  digestToHex,
  type VerificationRecord,
} from "./safety-number";
import { saveVerification, loadVerification, clearVerification } from "./idb";
import { WORDLIST } from "./wordlist";

function keyFrom(seed: number): Uint8Array {
  return new Uint8Array(32).map((_, i) => (i * seed + seed) & 0xff);
}

const KNOWN_DIGEST_ALICE_BOB = "53416b656b848758c92bbcbbc42cfe1edfdcb4cfcd343635fbabc0b84e403892";

const ALICE = keyFrom(7);
const BOB = keyFrom(13);
const CAROL = keyFrom(29);

test("safety number is order-independent (both parties compute the same code)", async () => {
  const ab = await computeSafetyNumber(ALICE, BOB);
  const ba = await computeSafetyNumber(BOB, ALICE);
  assert.equal(digestToHex(ab.digest), digestToHex(ba.digest));
  assert.deepEqual(ab.words, ba.words);
  assert.equal(ab.numeric, ba.numeric);
});

test("safety number is deterministic for the same key pair", async () => {
  const one = await computeSafetyNumber(ALICE, BOB);
  const two = await computeSafetyNumber(ALICE, BOB);
  assert.equal(digestToHex(one.digest), digestToHex(two.digest));
});

test("different peers produce different safety numbers", async () => {
  const ab = await computeSafetyNumber(ALICE, BOB);
  const ac = await computeSafetyNumber(ALICE, CAROL);
  assert.notEqual(digestToHex(ab.digest), digestToHex(ac.digest));
  assert.notDeepEqual(ab.words, ac.words);
});

test("a changed peer key changes the safety number (MITM/rotation detectable)", async () => {
  const before = await computeSafetyNumber(ALICE, BOB);
  const substituted = keyFrom(99); // attacker swaps Bob's key
  const after = await computeSafetyNumber(ALICE, substituted);
  assert.notEqual(digestToHex(before.digest), digestToHex(after.digest));
});

test("rendering: 8 valid wordlist words + a 60-digit grouped numeric", async () => {
  const sn = await computeSafetyNumber(ALICE, BOB);
  assert.equal(sn.words.length, 8);
  for (const w of sn.words) assert.ok(WORDLIST.includes(w), `not a wordlist word: ${w}`);
  // numeric: 60 digits + grouping spaces, digits only otherwise
  const digitsOnly = sn.numeric.replace(/ /g, "");
  assert.equal(digitsOnly.length, 60);
  assert.match(digitsOnly, /^[0-9]{60}$/);
});

test("known-answer: pins the derivation so it can't silently drift", async () => {
  const sn = await computeSafetyNumber(ALICE, BOB);
  // computed once from this exact impl; a change here means the derivation
  // changed and every existing verification would break.
  assert.equal(
    digestToHex(sn.digest),
    KNOWN_DIGEST_ALICE_BOB,
    "derivation drifted -- safety numbers would no longer match across versions",
  );
});

// ---- verification status ----

test("verificationState: unverified / verified / changed", () => {
  const digest = new Uint8Array([1, 2, 3, 4]);
  const rec: VerificationRecord = {
    peerUserID: "bob",
    digestHex: digestToHex(digest),
    generation: 1,
    verifiedAt: Date.now(),
  };
  assert.equal(verificationState(digest, null), "unverified");
  assert.equal(verificationState(digest, rec), "verified");
  // a different current digest (key changed) -> changed
  assert.equal(verificationState(new Uint8Array([9, 9, 9, 9]), rec), "changed");
});

// ---- idb store ----

test("verification record: save / load / clear round-trip", async () => {
  const rec: VerificationRecord = {
    peerUserID: "bob",
    digestHex: "deadbeef",
    generation: 1,
    verifiedAt: 1234567890,
  };
  await saveVerification(rec);
  const got = await loadVerification("bob");
  assert.deepEqual(got, rec);

  assert.equal(await loadVerification("nobody"), null);

  await clearVerification("bob");
  assert.equal(await loadVerification("bob"), null);
});


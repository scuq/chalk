// chalk-web -- phase31-slice31-5 authkdf tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveAuth,
  newAuthSalt,
  seal,
  unseal,
  wrapEntropy,
  unwrapEntropy,
  checkPasswordPolicy,
  estimateStrength,
  toB64,
  fromB64,
  DEFAULT_KDF,
  type KdfParams,
} from "./authkdf";

// Small params so tests run fast; production uses DEFAULT_KDF.
const testParams = (salt: Uint8Array): KdfParams => ({
  alg: 1,
  memKiB: 8192,
  iters: 1,
  par: 1,
  salt,
});

test("deriveAuth is deterministic and split is independent", async () => {
  const salt = new Uint8Array(16).fill(7);
  const a = await deriveAuth("correct horse Battery staple 99!", testParams(salt));
  const b = await deriveAuth("correct horse Battery staple 99!", testParams(salt));
  assert.deepEqual(a.authProof, b.authProof);
  assert.deepEqual(a.kek, b.kek);
  assert.equal(a.authProof.length, 32);
  assert.equal(a.kek.length, 32);
  assert.notDeepEqual(a.authProof, a.kek); // label separation
});

test("different password or salt changes both outputs", async () => {
  const salt = new Uint8Array(16).fill(7);
  const base = await deriveAuth("password-one AAaa11!!....", testParams(salt));
  const otherPw = await deriveAuth("password-two AAaa11!!....", testParams(salt));
  assert.notDeepEqual(base.authProof, otherPw.authProof);
  const salt2 = new Uint8Array(16).fill(8);
  const otherSalt = await deriveAuth("password-one AAaa11!!....", testParams(salt2));
  assert.notDeepEqual(base.authProof, otherSalt.authProof);
});

test("seal/unseal round-trip; tamper and wrong key fail", async () => {
  const key = new Uint8Array(32).fill(3);
  const msg = new TextEncoder().encode("hello chalk");
  const blob = await seal(msg, key);
  assert.equal(blob.length, 12 + msg.length + 16); // nonce + ct + tag
  const back = await unseal(blob, key);
  assert.deepEqual(back, msg);

  const tampered = blob.slice();
  tampered[tampered.length - 1] ^= 0xff;
  await assert.rejects(() => unseal(tampered, key));

  const wrong = new Uint8Array(32).fill(4);
  await assert.rejects(() => unseal(blob, wrong));
});

test("wrapEntropy round-trips 32-byte entropy under derived KEK", async () => {
  const salt = newAuthSalt();
  const { kek } = await deriveAuth("Some very Long passphrase 42!?", testParams(salt));
  const entropy = new Uint8Array(32);
  crypto.getRandomValues(entropy);
  const blob = await wrapEntropy(entropy, kek);
  const back = await unwrapEntropy(blob, kek);
  assert.deepEqual(back, entropy);
  await assert.rejects(() => wrapEntropy(new Uint8Array(31), kek)); // wrong size
});

test("password policy: all four classes + length enforced", () => {
  assert.equal(checkPasswordPolicy("Correct horse Battery 9!").ok, true);
  assert.deepEqual(checkPasswordPolicy("short A1!").missing, ["length"]);
  assert.ok(checkPasswordPolicy("all lower case with 123 !!").missing.includes("upper"));
  assert.ok(checkPasswordPolicy("ALL UPPER CASE WITH 123 !!").missing.includes("lower"));
  assert.ok(checkPasswordPolicy("No Digits Here But Long!!").missing.includes("digit"));
  assert.ok(checkPasswordPolicy("NoSpecialChars123456789A").missing.includes("special"));
  // space counts as special (passphrases encouraged)
  assert.equal(checkPasswordPolicy("Passphrase with spaces 42").ok, true);
});

test("strength meter is ordinal-sane", () => {
  assert.equal(estimateStrength(""), 0);
  const weak = estimateStrength("aaaaaaaaaaaaaaaaaaaaaaaa");
  const strong = estimateStrength("kV9#mQ2$xL7!pW4@zR8&nT3^");
  assert.ok(weak < strong, `weak=${weak} strong=${strong}`);
  assert.ok(strong >= 3);
});

test("b64 helpers round-trip", () => {
  const b = new Uint8Array([0, 1, 2, 250, 255]);
  assert.deepEqual(fromB64(toB64(b)), b);
});

test("DEFAULT_KDF meets the server floor", () => {
  assert.equal(DEFAULT_KDF.alg, 1);
  assert.ok(DEFAULT_KDF.memKiB >= 262144);
  assert.ok(DEFAULT_KDF.iters >= 3);
  assert.ok(DEFAULT_KDF.par >= 1);
});

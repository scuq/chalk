// Unit tests for src/webauthn.ts. Pure-logic only; the
// performRegistration call requires a browser (navigator.credentials).
//
// Run via `node test.mjs` from web/. The runner transpiles each .test.ts
// via esbuild and executes under node --test.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  bytesToBase64url,
  base64urlToBytes,
  classifyWebAuthnError,
  WebAuthnError,
} from "./webauthn";

// ---- base64url round-trips ---------------------------------------------

test("base64url empty roundtrip", () => {
  assert.equal(bytesToBase64url(new Uint8Array(0)), "");
  assert.equal(base64urlToBytes("").length, 0);
});

test("base64url single byte values", () => {
  // 1 input byte → 2 base64 chars, no padding in url-safe form.
  const cases: Array<[number[], string]> = [
    [[0x00], "AA"],
    [[0xff], "_w"],
    [[0x41], "QQ"],
  ];
  for (const [input, expected] of cases) {
    const got = bytesToBase64url(new Uint8Array(input));
    assert.equal(got, expected, `encode ${input.join(",")}`);
    const back = base64urlToBytes(got);
    assert.deepEqual(Array.from(back), input);
  }
});

test("base64url url-safe alphabet uses - and _", () => {
  // Byte sequences that would produce + and / in standard base64.
  // 0xfb 0xff produces "+/8" → url-safe "-_8".
  const got = bytesToBase64url(new Uint8Array([0xfb, 0xff, 0xff]));
  assert.ok(!got.includes("+"), `got ${got} should not contain +`);
  assert.ok(!got.includes("/"), `got ${got} should not contain /`);
  // Round trip.
  assert.deepEqual(Array.from(base64urlToBytes(got)), [0xfb, 0xff, 0xff]);
});

test("base64url no trailing padding", () => {
  // 1-byte input would be "AA==" in standard base64. We strip padding.
  assert.ok(!bytesToBase64url(new Uint8Array([0])).includes("="));
  assert.ok(!bytesToBase64url(new Uint8Array([0, 0])).includes("="));
  assert.ok(!bytesToBase64url(new Uint8Array([0, 0, 0])).includes("="));
});

test("base64url decode accepts standard base64 padded input", () => {
  // Some tooling produces "+/8=" or "Ag==" style strings. We should
  // accept both flavors.
  assert.deepEqual(Array.from(base64urlToBytes("Ag==")), [0x02]);
  assert.deepEqual(Array.from(base64urlToBytes("Ag")), [0x02]);
  assert.deepEqual(Array.from(base64urlToBytes("+/8=")), [0xfb, 0xff]);
  assert.deepEqual(Array.from(base64urlToBytes("-_8")), [0xfb, 0xff]);
});

test("base64url decode rejects length-mod-4 == 1", () => {
  // Lengths 1, 5, 9 etc. are not valid base64.
  assert.throws(() => base64urlToBytes("A"), /invalid length/);
});

test("base64url accepts ArrayBuffer input", () => {
  const buf = new Uint8Array([0xde, 0xad, 0xbe, 0xef]).buffer;
  const s = bytesToBase64url(buf);
  assert.deepEqual(Array.from(base64urlToBytes(s)), [0xde, 0xad, 0xbe, 0xef]);
});

test("base64url accepts subarray (TypedArray view) input", () => {
  // Catch a class of bug: TypedArrays can be views over a larger
  // buffer with a non-zero byteOffset. We must encode only the bytes
  // in the view, not the underlying buffer.
  const full = new Uint8Array([0x11, 0x22, 0x33, 0x44, 0x55]);
  const view = full.subarray(1, 4); // [0x22, 0x33, 0x44]
  const s = bytesToBase64url(view);
  assert.deepEqual(Array.from(base64urlToBytes(s)), [0x22, 0x33, 0x44]);
});

test("base64url roundtrips a realistic WebAuthn challenge (32 bytes)", () => {
  // 32 random-ish bytes simulating a challenge.
  const challenge = new Uint8Array(32);
  for (let i = 0; i < 32; i++) challenge[i] = (i * 7 + 11) & 0xff;
  const s = bytesToBase64url(challenge);
  assert.deepEqual(Array.from(base64urlToBytes(s)), Array.from(challenge));
});

// ---- error classification ---------------------------------------------

test("classifyWebAuthnError maps NotAllowedError to user_cancelled", () => {
  const e = new Error("user denied");
  (e as { name: string }).name = "NotAllowedError";
  const classified = classifyWebAuthnError(e);
  assert.ok(classified instanceof WebAuthnError);
  assert.equal(classified.kind, "user_cancelled");
});

test("classifyWebAuthnError maps AbortError to user_cancelled", () => {
  const e = new Error("aborted");
  (e as { name: string }).name = "AbortError";
  assert.equal(classifyWebAuthnError(e).kind, "user_cancelled");
});

test("classifyWebAuthnError maps ConstraintError to constraint", () => {
  const e = new Error("nope");
  (e as { name: string }).name = "ConstraintError";
  assert.equal(classifyWebAuthnError(e).kind, "constraint");
});

test("classifyWebAuthnError maps NotSupportedError to constraint", () => {
  const e = new Error("no algorithm");
  (e as { name: string }).name = "NotSupportedError";
  assert.equal(classifyWebAuthnError(e).kind, "constraint");
});

test("classifyWebAuthnError maps SecurityError to security", () => {
  const e = new Error("rp mismatch");
  (e as { name: string }).name = "SecurityError";
  assert.equal(classifyWebAuthnError(e).kind, "security");
});

test("classifyWebAuthnError defaults unknown errors to 'unknown'", () => {
  assert.equal(classifyWebAuthnError(new Error("???")).kind, "unknown");
  assert.equal(classifyWebAuthnError("plain string").kind, "unknown");
  assert.equal(classifyWebAuthnError({ weird: "object" }).kind, "unknown");
});

test("classifyWebAuthnError passes through existing WebAuthnError", () => {
  const original = new WebAuthnError("not_supported", "test");
  const classified = classifyWebAuthnError(original);
  // Should be the same instance, not wrapped again.
  assert.equal(classified, original);
});

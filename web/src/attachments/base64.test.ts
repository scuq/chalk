// Tests for attachments/base64.ts. These bytes cross the wire to a Go server
// that uses base64.StdEncoding for []byte JSON fields, so the encoding MUST be
// standard base64 (with padding), byte-exact.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { bytesToBase64, base64ToBytes } from "./base64";

test("bytesToBase64 matches Go base64.StdEncoding for known vectors", () => {
  // "hello" -> aGVsbG8= ; "foobar" -> Zm9vYmFy ; "f" -> Zg==
  assert.equal(bytesToBase64(new TextEncoder().encode("hello")), "aGVsbG8=");
  assert.equal(bytesToBase64(new TextEncoder().encode("foobar")), "Zm9vYmFy");
  assert.equal(bytesToBase64(new TextEncoder().encode("f")), "Zg==");
  assert.equal(bytesToBase64(new Uint8Array([])), "");
});

test("base64ToBytes is the inverse of bytesToBase64", () => {
  assert.deepEqual(Array.from(base64ToBytes("aGVsbG8=")), Array.from(new TextEncoder().encode("hello")));
  assert.deepEqual(Array.from(base64ToBytes("Zg==")), [0x66]);
});

test("round-trips arbitrary binary including high bytes and nulls", () => {
  const cases: Uint8Array[] = [
    new Uint8Array([0, 1, 2, 254, 255]),
    new Uint8Array(256).map((_, i) => i & 0xff),
    crypto.getRandomValues(new Uint8Array(1000)),
  ];
  for (const bytes of cases) {
    const round = base64ToBytes(bytesToBase64(bytes));
    assert.deepEqual(Array.from(round), Array.from(bytes));
  }
});

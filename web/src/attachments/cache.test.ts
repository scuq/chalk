// Tests for attachments/cache.ts -- the LRU-bounded ciphertext cache. Uses
// fake-indexeddb so the real idb store path is exercised end to end.

import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  cacheGet,
  cachePut,
  cacheTotalBytes,
  clearCache,
  setCacheMaxBytes,
  getCacheMaxBytes,
} from "./cache";

function blob(n: number, fill: number): Uint8Array {
  return new Uint8Array(n).fill(fill);
}

test("cachePut then cacheGet returns the stored ciphertext", async () => {
  setCacheMaxBytes(1024 * 1024);
  await clearCache();
  const b = blob(64, 7);
  await cachePut("att-1", 1, "full", b);
  const got = await cacheGet("att-1", 1, "full");
  assert.ok(got);
  assert.deepEqual(Array.from(got!), Array.from(b));
});

test("cacheGet miss returns null; variants and versions are distinct keys", async () => {
  setCacheMaxBytes(1024 * 1024);
  await clearCache();
  await cachePut("att-2", 1, "full", blob(16, 1));
  assert.equal(await cacheGet("att-2", 1, "preview"), null, "preview is a separate key");
  assert.equal(await cacheGet("att-2", 2, "full"), null, "version 2 is a separate key");
  assert.equal(await cacheGet("nope", 1, "full"), null, "unknown id misses");
});

test("LRU evicts to keep total cached bytes within the cap", async () => {
  setCacheMaxBytes(100);
  await clearCache();
  // Three 40-byte blobs = 120 bytes total, over the 100-byte cap.
  await cachePut("a", 1, "full", blob(40, 1));
  await cachePut("b", 1, "full", blob(40, 2));
  await cachePut("c", 1, "full", blob(40, 3));
  const total = await cacheTotalBytes();
  assert.ok(total <= 100, `total ${total} should be within cap 100`);
  assert.ok(total >= 40, `at least one blob should remain (total ${total})`);
  // The most recently inserted blob must still be present.
  const c = await cacheGet("c", 1, "full");
  assert.ok(c, "most-recently-put blob survives eviction");
});

test("a blob larger than the whole cap is not cached", async () => {
  setCacheMaxBytes(100);
  await clearCache();
  await cachePut("huge", 1, "full", blob(200, 9));
  assert.equal(await cacheGet("huge", 1, "full"), null);
  assert.equal(await cacheTotalBytes(), 0);
});

test("clearCache empties the store", async () => {
  setCacheMaxBytes(1024 * 1024);
  await clearCache();
  await cachePut("x", 1, "full", blob(32, 5));
  await clearCache();
  assert.equal(await cacheTotalBytes(), 0);
  assert.equal(await cacheGet("x", 1, "full"), null);
});

test("setCacheMaxBytes ignores non-positive values", () => {
  setCacheMaxBytes(12345);
  setCacheMaxBytes(0);
  setCacheMaxBytes(-1);
  assert.equal(getCacheMaxBytes(), 12345);
});

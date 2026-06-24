// Tests for attachments/pipeline.ts: the wire->ref mapping and the receive-side
// controller. A stub ChannelCrypto controls decryption so we test the
// orchestration (cache-first, base64 decode, meta parse) without real crypto or
// network. The cache-HIT path is exercised against fake-indexeddb; the cache
// MISS path (which fetches over HTTP) is left to integration testing.

import "fake-indexeddb/auto";
import { test } from "node:test";
import { strict as assert } from "node:assert";

import { wireRefToRef, makeAttachmentController } from "./pipeline";
import { cachePut, clearCache, setCacheMaxBytes } from "./cache";
import { bytesToBase64 } from "./base64";
import { encodeMeta } from "./preview";
import type { AttachmentMeta, AttachmentRef } from "./types";
import type { ChannelCrypto } from "../crypto/channel-crypto";
import type { AttachmentListItemWire } from "../proto";

// A stub ChannelCrypto whose decryptBytesForChannel returns the ciphertext
// unchanged (identity "decrypt"), so we can assert the controller's plumbing.
function identityCrypto(): ChannelCrypto {
  return {
    async decryptBytesForChannel(_c: string, _v: number, ct: Uint8Array) {
      return ct;
    },
  } as unknown as ChannelCrypto;
}

// A stub that always fails to decrypt (key not held) -> fail-closed.
function lockedCrypto(): ChannelCrypto {
  return {
    async decryptBytesForChannel() {
      return null;
    },
  } as unknown as ChannelCrypto;
}

test("wireRefToRef maps the list-item wire shape into the client ref", () => {
  const w: AttachmentListItemWire = {
    id: "att-9",
    channel_id: "chan-1",
    message_id: "msg-7",
    byte_len: 4242,
    key_version: 3,
    enc_meta: "bWV0YQ==",
    enc_preview: "cHJldg==",
    preview_len: 5,
    created_at: 1700000000000,
  };
  const ref = wireRefToRef(w);
  assert.deepEqual(ref, {
    id: "att-9",
    byteLen: 4242,
    keyVersion: 3,
    encMetaB64: "bWV0YQ==",
    encPreviewB64: "cHJldg==",
    previewLen: 5,
  });
});

test("wireRefToRef defaults preview_len to 0 when absent", () => {
  const ref = wireRefToRef({
    id: "x",
    channel_id: "c",
    byte_len: 1,
    key_version: 1,
    enc_meta: "AA==",
    created_at: 0,
  });
  assert.equal(ref.previewLen, 0);
  assert.equal(ref.encPreviewB64, undefined);
});

function refWithMeta(meta: AttachmentMeta, fullCipher?: Uint8Array): AttachmentRef {
  return {
    id: "att-meta",
    byteLen: fullCipher?.byteLength ?? 0,
    keyVersion: 1,
    encMetaB64: bytesToBase64(encodeMeta(meta)),
    previewLen: 0,
  };
}

test("controller.decryptMeta parses enc_meta when the key is held", async () => {
  const ctrl = makeAttachmentController(identityCrypto());
  const meta: AttachmentMeta = { name: "a.png", mime: "image/png", kind: "image", size: 9 };
  const got = await ctrl.decryptMeta("chan", refWithMeta(meta));
  assert.deepEqual(got, meta);
});

test("controller.decryptMeta fails closed (null) when the key is not held", async () => {
  const ctrl = makeAttachmentController(lockedCrypto());
  const meta: AttachmentMeta = { name: "a.png", mime: "image/png", kind: "image", size: 9 };
  assert.equal(await ctrl.decryptMeta("chan", refWithMeta(meta)), null);
});

test("controller.loadFullBytes serves from cache without a network fetch", async () => {
  setCacheMaxBytes(1024 * 1024);
  await clearCache();
  const ctrl = makeAttachmentController(identityCrypto());
  const cipher = new Uint8Array([10, 20, 30, 40]);
  // Pre-seed the cache; with identity "decrypt" the bytes pass through.
  await cachePut("att-meta", 1, "full", cipher);
  const meta: AttachmentMeta = { name: "a.bin", mime: "application/octet-stream", kind: "file", size: 4 };
  const out = await ctrl.loadFullBytes("chan", refWithMeta(meta, cipher));
  assert.ok(out);
  assert.deepEqual(Array.from(out!), Array.from(cipher));
});

test("controller.loadPreviewBytes returns null when there is no preview", async () => {
  const ctrl = makeAttachmentController(identityCrypto());
  const meta: AttachmentMeta = { name: "a.bin", mime: "application/octet-stream", kind: "file", size: 4 };
  assert.equal(await ctrl.loadPreviewBytes("chan", refWithMeta(meta)), null);
});

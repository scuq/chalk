// Tests for the enc_meta serialization helpers in attachments/preview.ts
// (encodeMeta / decodeMeta). The DOM-bound makePreview is not exercised here
// (no canvas in node); these cover the bytes that become enc_meta.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { encodeMeta, decodeMeta } from "./preview";
import type { AttachmentMeta } from "./types";

test("encodeMeta -> decodeMeta round-trips an image meta", () => {
  const meta: AttachmentMeta = {
    name: "screenshot.png",
    mime: "image/png",
    kind: "image",
    size: 12345,
    width: 1920,
    height: 1080,
  };
  const back = decodeMeta(encodeMeta(meta));
  assert.deepEqual(back, meta);
});

test("encodeMeta -> decodeMeta round-trips a file meta without dimensions", () => {
  const meta: AttachmentMeta = {
    name: "report.pdf",
    mime: "application/pdf",
    kind: "file",
    size: 4096,
  };
  const back = decodeMeta(encodeMeta(meta));
  assert.deepEqual(back, meta);
});

test("decodeMeta derives kind from mime when kind is absent/invalid", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ name: "x.png", mime: "image/png", size: 10 }),
  );
  const back = decodeMeta(bytes);
  assert.ok(back);
  assert.equal(back!.kind, "image");
});

test("decodeMeta rejects garbage and missing required fields", () => {
  assert.equal(decodeMeta(new TextEncoder().encode("not json")), null);
  assert.equal(decodeMeta(new TextEncoder().encode("{}")), null);
  assert.equal(
    decodeMeta(new TextEncoder().encode(JSON.stringify({ name: "x" }))),
    null,
  );
});

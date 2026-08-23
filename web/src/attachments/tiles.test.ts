// Tests for attachments/tiles.ts pure helpers.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import type { AttachmentRef } from "./types";
import { TILE_CAP, isImageRef, tileLayout } from "./tiles";

function ref(over: Partial<AttachmentRef>): AttachmentRef {
  return {
    id: "a",
    byteLen: 100,
    keyVersion: 1,
    encMetaB64: "meta",
    previewLen: 0,
    ...over,
  };
}

test("isImageRef keys off the inline preview, not decrypted meta", () => {
  assert.equal(isImageRef(ref({ previewLen: 42 })), true);
  assert.equal(isImageRef(ref({ encPreviewB64: "prev" })), true);
  assert.equal(isImageRef(ref({ previewLen: 42, encPreviewB64: "prev" })), true);
  // No preview -> file kind (documents never carry one).
  assert.equal(isImageRef(ref({})), false);
});

test("tileLayout collapsed caps at TILE_CAP and reports the remainder", () => {
  assert.deepEqual(tileLayout(2, false), { visible: 2, hidden: 0, wideFirst: false });
  assert.deepEqual(tileLayout(3, false), { visible: 3, hidden: 0, wideFirst: true });
  assert.deepEqual(tileLayout(4, false), { visible: 4, hidden: 0, wideFirst: false });
  assert.deepEqual(tileLayout(5, false), { visible: 4, hidden: 1, wideFirst: false });
  assert.deepEqual(tileLayout(9, false), { visible: TILE_CAP, hidden: 5, wideFirst: false });
});

test("tileLayout expanded shows everything, first tile wide on odd counts", () => {
  assert.deepEqual(tileLayout(5, true), { visible: 5, hidden: 0, wideFirst: true });
  assert.deepEqual(tileLayout(6, true), { visible: 6, hidden: 0, wideFirst: false });
  assert.deepEqual(tileLayout(9, true), { visible: 9, hidden: 0, wideFirst: true });
});

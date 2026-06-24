// Tests for attachments/types.ts pure helpers.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { classifyKind, humanSize } from "./types";

test("classifyKind treats image/* as image, everything else as file", () => {
  assert.equal(classifyKind("image/png"), "image");
  assert.equal(classifyKind("image/jpeg"), "image");
  assert.equal(classifyKind("image/gif"), "image");
  assert.equal(classifyKind("application/pdf"), "file");
  assert.equal(classifyKind("text/plain"), "file");
  assert.equal(classifyKind("application/octet-stream"), "file");
  assert.equal(classifyKind(""), "file");
});

test("humanSize formats bytes/KB/MB/GB sensibly", () => {
  assert.equal(humanSize(0), "0 B");
  assert.equal(humanSize(512), "512 B");
  assert.equal(humanSize(1023), "1023 B");
  assert.equal(humanSize(1024), "1.0 KB");
  assert.equal(humanSize(1536), "1.5 KB");
  // >= 10 of a unit rounds to an integer.
  assert.equal(humanSize(10 * 1024), "10 KB");
  assert.equal(humanSize(1024 * 1024), "1.0 MB");
  assert.equal(humanSize(20 * 1024 * 1024), "20 MB");
  assert.equal(humanSize(1024 * 1024 * 1024), "1.0 GB");
});

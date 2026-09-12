// Tests for attachments/types.ts pure helpers.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { classifyKind, formatDuration, humanSize } from "./types";

test("classifyKind treats image/* as image, video/* as video, everything else as file", () => {
  assert.equal(classifyKind("image/png"), "image");
  assert.equal(classifyKind("image/jpeg"), "image");
  assert.equal(classifyKind("image/gif"), "image");
  // 121-1
  assert.equal(classifyKind("video/mp4"), "video");
  assert.equal(classifyKind("video/webm"), "video");
  assert.equal(classifyKind("video/quicktime"), "video");
  assert.equal(classifyKind("audio/mpeg"), "file");
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

test("121-1: formatDuration floors to m:ss, h:mm:ss past an hour, junk as 0:00", () => {
  assert.equal(formatDuration(0), "0:00");
  assert.equal(formatDuration(7), "0:07");
  assert.equal(formatDuration(7.4), "0:07");
  // Floored like a player's clock, never rounded up.
  assert.equal(formatDuration(2.6), "0:02");
  assert.equal(formatDuration(59.6), "0:59");
  assert.equal(formatDuration(60), "1:00");
  assert.equal(formatDuration(83), "1:23");
  assert.equal(formatDuration(600), "10:00");
  assert.equal(formatDuration(3600), "1:00:00");
  assert.equal(formatDuration(3600 + 5 * 60 + 9), "1:05:09");
  assert.equal(formatDuration(NaN), "0:00");
  assert.equal(formatDuration(Infinity), "0:00");
  assert.equal(formatDuration(-3), "0:00");
});

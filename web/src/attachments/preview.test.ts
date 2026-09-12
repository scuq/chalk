// Tests for the enc_meta serialization helpers in attachments/preview.ts
// (encodeMeta / decodeMeta). The DOM-bound makePreview is not exercised here
// (no canvas in node); these cover the bytes that become enc_meta.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { encodeMeta, decodeMeta, posterSeekTime } from "./preview";
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

test("121-1: encodeMeta -> decodeMeta round-trips a video meta with its duration", () => {
  const meta: AttachmentMeta = {
    name: "Peek 2026-09-10 21-01.mp4",
    mime: "video/mp4",
    kind: "video",
    size: 672_768,
    width: 1280,
    height: 720,
    duration: 12.48,
  };
  const back = decodeMeta(encodeMeta(meta));
  assert.deepEqual(back, meta);
});

test("121-1: decodeMeta drops a duration that is not a finite number", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ name: "clip.mp4", mime: "video/mp4", kind: "video", size: 10, duration: "12" }),
  );
  const back = decodeMeta(bytes);
  assert.ok(back);
  assert.equal(back!.kind, "video");
  assert.equal(back!.duration, undefined);
});

test("121-1: decodeMeta derives video from mime when kind is absent", () => {
  const bytes = new TextEncoder().encode(
    JSON.stringify({ name: "clip.webm", mime: "video/webm", size: 10 }),
  );
  assert.equal(decodeMeta(bytes)!.kind, "video");
});

test("121-1: posterSeekTime is a second in, never past the middle, 0 for unreadable", () => {
  assert.equal(posterSeekTime(60), 1);
  assert.equal(posterSeekTime(2), 1);
  assert.equal(posterSeekTime(1), 0.5);
  assert.equal(posterSeekTime(0.2), 0.1);
  assert.equal(posterSeekTime(0), 0);
  assert.equal(posterSeekTime(NaN), 0);
  assert.equal(posterSeekTime(Infinity), 0);
  assert.equal(posterSeekTime(-1), 0);
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

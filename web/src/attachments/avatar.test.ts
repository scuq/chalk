// 112-2: the gate and the square. The canvas draw needs a DOM (the UI probe
// covers it); what is here is the arithmetic that decides which pixels are
// kept when a chosen region is not square.

import test from "node:test";
import assert from "node:assert/strict";
import { AVATAR_MAX_INPUT_BYTES, avatarRejectReason, coverBox } from "./avatar";

test("an image within the cap is accepted", () => {
  assert.equal(avatarRejectReason("image/png", 4096), null);
  assert.equal(avatarRejectReason("image/webp", AVATAR_MAX_INPUT_BYTES), null);
});

test("a non-image, or an enormous one, is refused before decoding", () => {
  assert.equal(avatarRejectReason("application/pdf", 10), "that is not an image");
  assert.equal(avatarRejectReason("", 10), "that is not an image");
  assert.match(avatarRejectReason("image/png", AVATAR_MAX_INPUT_BYTES + 1) ?? "", /too large/);
});

test("a square region is used whole", () => {
  assert.deepEqual(coverBox(400, 400), { sx: 0, sy: 0, size: 400 });
});

test("a wide region is trimmed evenly at both ends, never stretched", () => {
  const box = coverBox(400, 200);
  assert.equal(box.size, 200);
  assert.equal(box.sy, 0);
  assert.equal(box.sx, 100); // (400-200)/2 -- the same amount off each side
});

test("a tall region is trimmed the same way", () => {
  const box = coverBox(200, 500);
  assert.equal(box.size, 200);
  assert.equal(box.sx, 0);
  assert.equal(box.sy, 150);
});

test("a degenerate region still yields a pixel to draw", () => {
  assert.equal(coverBox(0, 0).size, 1);
  assert.equal(coverBox(1, 900).size, 1);
});

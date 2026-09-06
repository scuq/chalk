// 111-2: the pre-decode gate on a banner upload. The downscale itself needs a
// canvas and is exercised by the UI probe; this is the part that can say no
// before anything is read.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BANNER_MAX_INPUT_BYTES,
  BANNER_MAX_EDGE,
  bannerRejectReason,
} from "./banner";

test("an image within the cap is accepted", () => {
  assert.equal(bannerRejectReason("image/png", 1024), null);
  assert.equal(bannerRejectReason("image/jpeg", BANNER_MAX_INPUT_BYTES), null);
});

test("a non-image is refused before anything is decoded", () => {
  assert.equal(bannerRejectReason("application/pdf", 1024), "that is not an image");
  assert.equal(bannerRejectReason("", 1024), "that is not an image");
  // A video is the near miss worth naming: it has a preview-able first frame
  // and is still not a banner.
  assert.equal(bannerRejectReason("video/mp4", 1024), "that is not an image");
});

test("an oversize image is refused by size, not by decode failure", () => {
  const why = bannerRejectReason("image/png", BANNER_MAX_INPUT_BYTES + 1);
  assert.match(why ?? "", /too large/);
});

test("the downscale edge stays above the widest band a screen can show", () => {
  // The band is full-pane width; a full-window layout on a 2560px display at
  // 2x device pixels is the ceiling this number answers to.
  assert.ok(BANNER_MAX_EDGE >= 1280);
});

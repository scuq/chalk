// 115-6: the frame list is the seam between the server's allowlist and the
// stylesheet, and normalizeFrame is what keeps an unknown value harmless.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { AVATAR_FRAMES, normalizeFrame } from "./frames";

test("none comes first and every frame is unique", () => {
  assert.equal(AVATAR_FRAMES[0].value, "");
  const values = AVATAR_FRAMES.map((f) => f.value);
  assert.equal(new Set(values).size, values.length);
  for (const v of values) assert.ok(v.length <= 16, `${v} is longer than the column allows`);
});

test("normalizeFrame keeps a known frame and drops anything else", () => {
  for (const { value } of AVATAR_FRAMES) assert.equal(normalizeFrame(value), value);
  for (const junk of ["steam", "EMBER", null, undefined, 7, {}, "none"]) {
    assert.equal(normalizeFrame(junk), "");
  }
});

// Both files hold the same list by hand; this is the only thing that notices
// when one of them moves.
test("the server's allowlist names the same frames in the same order", () => {
  const go = readFileSync(
    join(resolve(process.cwd(), ".."), "internal", "auth", "avatar_frame_http.go"),
    "utf8",
  );
  const m = /var AvatarFrames = \[\]string\{([^}]*)\}/.exec(go);
  assert.ok(m, "AvatarFrames not found in avatar_frame_http.go");
  const server = [...m![1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
  assert.deepEqual(server, AVATAR_FRAMES.map((f) => f.value));
});

test("theme.css draws every frame but none", () => {
  const css = readFileSync(join(resolve(process.cwd(), "src"), "theme.css"), "utf8");
  for (const { value } of AVATAR_FRAMES) {
    if (value === "") continue;
    assert.ok(css.includes(`[data-frame="${value}"]`), `no rule for the ${value} frame`);
  }
});

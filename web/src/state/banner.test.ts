// 111-7: the layout a summary carried is repaired, not trusted. The server
// refuses bad writes; this is the other half -- what a renderer does when a
// value arrives anyway (an older client, a hand-written frame, a field this
// build has never heard of).

import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BANNER, normalizeBanner, sameBanner } from "./banner";

test("no picture is no layout", () => {
  assert.equal(normalizeBanner(null), null);
  assert.equal(normalizeBanner(undefined), null);
  assert.equal(normalizeBanner({}), null);
  assert.equal(normalizeBanner({ attachment_id: "" }), null);
  assert.equal(normalizeBanner({ attachment_id: "   " }), null);
  assert.equal(normalizeBanner("att-1"), null);
});

test("a full layout comes through as written", () => {
  assert.deepEqual(
    normalizeBanner({
      attachment_id: "att-1",
      fit: "fit",
      focus_x: 20,
      focus_y: 80,
      zoom: 150,
      height: "tall",
      bleed: "blur",
    }),
    {
      attachmentID: "att-1",
      fit: "fit",
      focusX: 20,
      focusY: 80,
      zoom: 150,
      height: "tall",
      bleed: "blur",
    },
  );
});

test("a picture with no layout is the pre-editor default", () => {
  assert.deepEqual(normalizeBanner({ attachment_id: "att-1" }), {
    attachmentID: "att-1",
    ...DEFAULT_BANNER,
  });
});

test("unknown enum values fall back rather than reaching the CSS", () => {
  const b = normalizeBanner({
    attachment_id: "att-1",
    fit: "cover",
    height: "88px",
    bleed: "mirror",
  });
  assert.equal(b?.fit, DEFAULT_BANNER.fit);
  assert.equal(b?.height, DEFAULT_BANNER.height);
  assert.equal(b?.bleed, DEFAULT_BANNER.bleed);
});

test("the shapes and bleeds this build knows all survive", () => {
  for (const fit of ["fill", "fit", "poster"]) {
    assert.equal(normalizeBanner({ attachment_id: "a", fit })?.fit, fit);
  }
  for (const bleed of ["wash", "blur", "none"]) {
    assert.equal(normalizeBanner({ attachment_id: "a", bleed })?.bleed, bleed);
  }
});

// 111-11: a channel saved before the rename chose the thing the wash
// replaced. Reading it as the default would silently reset someone's pick.
test("a pre-111-11 \"edge\" bleed reads as the wash", () => {
  assert.equal(normalizeBanner({ attachment_id: "a", bleed: "edge" })?.bleed, "wash");
});

test("numbers are clamped into range, and junk becomes the default", () => {
  const wild = normalizeBanner({
    attachment_id: "att-1",
    focus_x: -40,
    focus_y: 400,
    zoom: 9000,
  });
  assert.equal(wild?.focusX, 0);
  assert.equal(wild?.focusY, 100);
  assert.equal(wild?.zoom, 300);

  const junk = normalizeBanner({
    attachment_id: "att-1",
    focus_x: "left",
    zoom: NaN,
  });
  assert.equal(junk?.focusX, DEFAULT_BANNER.focusX);
  assert.equal(junk?.zoom, DEFAULT_BANNER.zoom);

  // A focus of 0 is a real value (the very edge of the picture) and must
  // not be mistaken for "unset".
  assert.equal(normalizeBanner({ attachment_id: "att-1", focus_x: 0 })?.focusX, 0);
  // Fractions come from dragging; the stored value is whole percent.
  assert.equal(normalizeBanner({ attachment_id: "att-1", focus_y: 33.6 })?.focusY, 34);
});

test("sameBanner is what keeps an ack and its push from rendering twice", () => {
  const a = normalizeBanner({ attachment_id: "att-1", zoom: 120 });
  const b = normalizeBanner({ attachment_id: "att-1", zoom: 120 });
  assert.ok(sameBanner(a, b));
  assert.ok(sameBanner(null, null));
  assert.ok(!sameBanner(a, null));
  assert.ok(!sameBanner(a, normalizeBanner({ attachment_id: "att-1", zoom: 130 })));
  assert.ok(!sameBanner(a, normalizeBanner({ attachment_id: "att-2", zoom: 120 })));
});

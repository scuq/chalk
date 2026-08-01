// Per-device display prefs: the parsing and application rules.
//
// What matters here is that a bad stored value can never make the app
// unreadable -- localStorage is user-editable, and an unrecognized font
// or a scale of 0 would render the UI unusable with no way back in.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyDisplayPrefs,
  DEFAULT_DISPLAY_PREFS,
  MAX_SCALE,
  MIN_SCALE,
  normalizeDisplayPrefs,
  SCALE_STEPS,
  type StyleTarget,
} from "./display-prefs.ts";

function styleStub(): StyleTarget & { props: Record<string, string> } {
  const props: Record<string, string> = {};
  return {
    props,
    style: {
      setProperty(name: string, value: string) {
        props[name] = value;
      },
    },
  };
}

test("normalize keeps a valid pref untouched", () => {
  assert.deepEqual(normalizeDisplayPrefs({ font: "serif", scale: 1.1, hideScrollbars: true }), {
    font: "serif",
    scale: 1.1,
    hideScrollbars: true,
  });
});

test("normalize falls back on junk input", () => {
  for (const junk of [null, undefined, 42, "sans", [], { font: "comic", scale: "big" }]) {
    assert.deepEqual(normalizeDisplayPrefs(junk), DEFAULT_DISPLAY_PREFS);
  }
});

test("normalize keeps the good half of a partially bad pref", () => {
  assert.deepEqual(normalizeDisplayPrefs({ font: "sans", scale: NaN }), {
    font: "sans",
    scale: DEFAULT_DISPLAY_PREFS.scale,
    hideScrollbars: DEFAULT_DISPLAY_PREFS.hideScrollbars,
  });
  assert.deepEqual(normalizeDisplayPrefs({ font: "wingdings", scale: 1.25 }), {
    font: DEFAULT_DISPLAY_PREFS.font,
    scale: 1.25,
    hideScrollbars: DEFAULT_DISPLAY_PREFS.hideScrollbars,
  });
  assert.equal(
    normalizeDisplayPrefs({ font: "mono", scale: 1, hideScrollbars: "yes" }).hideScrollbars,
    DEFAULT_DISPLAY_PREFS.hideScrollbars,
  );
});

test("normalize clamps rather than rejects out-of-range scales", () => {
  assert.equal(normalizeDisplayPrefs({ font: "mono", scale: 0 }).scale, MIN_SCALE);
  assert.equal(normalizeDisplayPrefs({ font: "mono", scale: 99 }).scale, MAX_SCALE);
  assert.equal(normalizeDisplayPrefs({ font: "mono", scale: -3 }).scale, MIN_SCALE);
});

test("normalize accepts a numeric string scale", () => {
  assert.equal(normalizeDisplayPrefs({ font: "mono", scale: "1.1" }).scale, 1.1);
});

test("every offered scale step survives normalization unchanged", () => {
  for (const step of SCALE_STEPS) {
    assert.equal(normalizeDisplayPrefs({ font: "mono", scale: step.value }).scale, step.value);
  }
});

test("apply writes the custom properties theme.css reads", () => {
  const el = styleStub();
  applyDisplayPrefs({ font: "sans", scale: 1.25, hideScrollbars: false }, el);
  assert.deepEqual(el.props, {
    "--chalk-font": "var(--chalk-font-sans)",
    "--chalk-font-scale": "1.25",
    "--chalk-scrollbar-width": "thin",
    "--chalk-scroll-lane": "var(--chalk-s2)",
  });
});

// Hiding the bars must also close the lane they stood in, or the feed keeps
// a strip of dead space on its right edge with nothing in it.
test("hiding scrollbars removes both the bar and its lane", () => {
  const el = styleStub();
  applyDisplayPrefs({ font: "mono", scale: 1, hideScrollbars: true }, el);
  assert.equal(el.props["--chalk-scrollbar-width"], "none");
  assert.equal(el.props["--chalk-scroll-lane"], "0px");
});

test("apply names a family alias for every offered font", () => {
  for (const font of ["mono", "sans", "serif"] as const) {
    const el = styleStub();
    applyDisplayPrefs({ font, scale: 1, hideScrollbars: false }, el);
    assert.equal(el.props["--chalk-font"], `var(--chalk-font-${font})`);
  }
});

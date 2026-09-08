// Per-device display prefs: the parsing and application rules.
//
// What matters here is that a bad stored value can never make the app
// unreadable -- localStorage is user-editable, and an unrecognized font
// or a scale of 0 would render the UI unusable with no way back in.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  APP_WIDTH_CHOICES,
  applyDisplayPrefs,
  CENTERED_MAX_WIDTH,
  DEFAULT_DISPLAY_PREFS,
  FONT_CHOICES,
  MAX_BURST_COUNT,
  MAX_BURST_MINUTES,
  MAX_SCALE,
  MIN_BURST_COUNT,
  MIN_BURST_MINUTES,
  MIN_SCALE,
  normalizeDisplayPrefs,
  SCALE_STEPS,
  type StyleTarget,
} from "./display-prefs.ts";

function styleStub(): StyleTarget & {
  props: Record<string, string>;
  attrs: Record<string, string>;
} {
  const props: Record<string, string> = {};
  const attrs: Record<string, string> = {};
  return {
    props,
    attrs,
    style: {
      setProperty(name: string, value: string) {
        props[name] = value;
      },
    },
    setAttribute(name: string, value: string) {
      attrs[name] = value;
    },
    removeAttribute(name: string) {
      delete attrs[name];
    },
  };
}

// 115-1: the flair fields as a pre-115 stored pref resolves them.
const FLAIR_DEFAULTS = {
  flair: false,
  flairFlame: true,
  flairWave: true,
  flairFrames: true,
  flairBanner: true,
  flairBurstCount: 4,
  flairBurstMinutes: 4,
};

test("normalize keeps a valid pref untouched", () => {
  assert.deepEqual(
    normalizeDisplayPrefs({
      font: "serif",
      scale: 1.1,
      hideScrollbars: true,
      appWidth: "full",
    }),
    {
      font: "serif",
      scale: 1.1,
      hideScrollbars: true,
      appWidth: "full",
      // 111-4: absent in a pre-111 stored pref, and the default is on --
      // upgrading shows channel images rather than hiding them.
      showChannelBanner: true,
      // 112-8/112-9: and the opposite for profile pictures -- absent means
      // off, so upgrading does not change how anyone's feed or roster reads.
      showAvatars: false,
      showRosterAvatars: false,
      ...FLAIR_DEFAULTS,
    },
  );
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
    appWidth: DEFAULT_DISPLAY_PREFS.appWidth,
    showChannelBanner: DEFAULT_DISPLAY_PREFS.showChannelBanner,
    showAvatars: DEFAULT_DISPLAY_PREFS.showAvatars,
    showRosterAvatars: DEFAULT_DISPLAY_PREFS.showRosterAvatars,
    ...FLAIR_DEFAULTS,
  });
  assert.deepEqual(normalizeDisplayPrefs({ font: "wingdings", scale: 1.25 }), {
    font: DEFAULT_DISPLAY_PREFS.font,
    scale: 1.25,
    hideScrollbars: DEFAULT_DISPLAY_PREFS.hideScrollbars,
    appWidth: DEFAULT_DISPLAY_PREFS.appWidth,
    showChannelBanner: DEFAULT_DISPLAY_PREFS.showChannelBanner,
    showAvatars: DEFAULT_DISPLAY_PREFS.showAvatars,
    showRosterAvatars: DEFAULT_DISPLAY_PREFS.showRosterAvatars,
    ...FLAIR_DEFAULTS,
  });
  // 111-4: a non-boolean is the default, like hideScrollbars above it.
  assert.equal(
    normalizeDisplayPrefs({ font: "mono", scale: 1, showChannelBanner: "yes" })
      .showChannelBanner,
    DEFAULT_DISPLAY_PREFS.showChannelBanner,
  );
  // An explicit false survives: turning banners off is the whole point.
  assert.equal(
    normalizeDisplayPrefs({ font: "mono", scale: 1, showChannelBanner: false })
      .showChannelBanner,
    false,
  );
  // 112-8: and an explicit true survives on the one that defaults to off.
  assert.equal(
    normalizeDisplayPrefs({ font: "mono", scale: 1, showAvatars: true }).showAvatars,
    true,
  );
  assert.equal(
    normalizeDisplayPrefs({ font: "mono", scale: 1, showAvatars: "yes" }).showAvatars,
    false,
  );
  // 112-9: the roster's switch is its own -- turning one on says nothing
  // about the other.
  const feedOnly = normalizeDisplayPrefs({ font: "mono", scale: 1, showAvatars: true });
  assert.equal(feedOnly.showRosterAvatars, false);
  const rosterOnly = normalizeDisplayPrefs({ font: "mono", scale: 1, showRosterAvatars: true });
  assert.equal(rosterOnly.showAvatars, false);
  assert.equal(rosterOnly.showRosterAvatars, true);
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
  applyDisplayPrefs(
    { font: "sans", scale: 1.25, hideScrollbars: false, appWidth: "centered" },
    el,
  );
  assert.deepEqual(el.props, {
    "--chalk-font": "var(--chalk-font-sans)",
    "--chalk-font-scale": "1.25",
    "--chalk-scrollbar-width": "thin",
    "--chalk-scroll-lane": "var(--chalk-s2)",
    "--chalk-app-max-w": CENTERED_MAX_WIDTH,
  });
});

// Hiding the bars must also close the lane they stood in, or the feed keeps
// a strip of dead space on its right edge with nothing in it.
test("hiding scrollbars removes both the bar and its lane", () => {
  const el = styleStub();
  applyDisplayPrefs(
    { font: "mono", scale: 1, hideScrollbars: true, appWidth: "centered" },
    el,
  );
  assert.equal(el.props["--chalk-scrollbar-width"], "none");
  assert.equal(el.props["--chalk-scroll-lane"], "0px");
});

// 93-1: the layout-width pref.

test("the layout defaults to the centred column", () => {
  assert.equal(DEFAULT_DISPLAY_PREFS.appWidth, "centered");
  assert.equal(normalizeDisplayPrefs({ font: "mono", scale: 1 }).appWidth, "centered");
});

test("an unrecognized stored width falls back to centred", () => {
  for (const junk of ["wide", "FULL", "", 1, true, null, {}]) {
    assert.equal(normalizeDisplayPrefs({ appWidth: junk }).appWidth, "centered");
  }
});

test("every offered width survives normalization unchanged", () => {
  for (const { value } of APP_WIDTH_CHOICES) {
    assert.equal(normalizeDisplayPrefs({ appWidth: value }).appWidth, value);
  }
});

// The pref only reaches the layout through this one property, so this is the
// whole feature: "none" lifts the cap, anything else keeps the centred column.
test("apply maps the width pref onto the shell's max-width", () => {
  for (const { value } of APP_WIDTH_CHOICES) {
    const el = styleStub();
    applyDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, appWidth: value }, el);
    assert.equal(
      el.props["--chalk-app-max-w"],
      value === "full" ? "none" : CENTERED_MAX_WIDTH,
    );
  }
});

test("apply names a family alias for every offered font", () => {
  for (const { value } of FONT_CHOICES) {
    const el = styleStub();
    applyDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, font: value }, el);
    assert.equal(el.props["--chalk-font"], `var(--chalk-font-${value})`);
  }
});

// A font the picker offers but normalize rejects would look like the
// setting silently refusing to stick.
test("every offered font survives normalization unchanged", () => {
  for (const { value } of FONT_CHOICES) {
    assert.equal(normalizeDisplayPrefs({ font: value, scale: 1 }).font, value);
  }
});

// 115-1: flair.

// Pinned on purpose: an animated chalk is something a person asks for, and
// flipping this to on is a decision someone should have to come here to make.
test("flair is off by default, and its four effects on", () => {
  assert.equal(DEFAULT_DISPLAY_PREFS.flair, false);
  const p = normalizeDisplayPrefs({ font: "mono", scale: 1 });
  assert.equal(p.flair, false);
  assert.equal(p.flairFlame, true);
  assert.equal(p.flairWave, true);
  assert.equal(p.flairFrames, true);
  assert.equal(p.flairBanner, true);
  assert.equal(p.flairBurstCount, 4);
  assert.equal(p.flairBurstMinutes, 4);
});

test("flair booleans keep an explicit value and reject a non-boolean", () => {
  const on = normalizeDisplayPrefs({ flair: true, flairWave: false });
  assert.equal(on.flair, true);
  assert.equal(on.flairWave, false);
  assert.equal(on.flairFlame, true);
  const junk = normalizeDisplayPrefs({ flair: "yes", flairFlame: 0, flairBanner: null });
  assert.equal(junk.flair, false);
  assert.equal(junk.flairFlame, true);
  assert.equal(junk.flairBanner, true);
});

test("the burst threshold is clamped, rounded and defaulted, never rejected", () => {
  assert.equal(normalizeDisplayPrefs({ flairBurstCount: 0 }).flairBurstCount, MIN_BURST_COUNT);
  assert.equal(normalizeDisplayPrefs({ flairBurstCount: 999 }).flairBurstCount, MAX_BURST_COUNT);
  assert.equal(normalizeDisplayPrefs({ flairBurstCount: 6.4 }).flairBurstCount, 6);
  assert.equal(normalizeDisplayPrefs({ flairBurstCount: "7" }).flairBurstCount, 7);
  assert.equal(normalizeDisplayPrefs({ flairBurstCount: "lots" }).flairBurstCount, 4);
  assert.equal(
    normalizeDisplayPrefs({ flairBurstMinutes: -1 }).flairBurstMinutes,
    MIN_BURST_MINUTES,
  );
  assert.equal(
    normalizeDisplayPrefs({ flairBurstMinutes: 1e9 }).flairBurstMinutes,
    MAX_BURST_MINUTES,
  );
  assert.equal(normalizeDisplayPrefs({ flairBurstMinutes: NaN }).flairBurstMinutes, 4);
});

// The effects are CSS rules gated on these attributes, so the attribute set
// IS the feature: nothing on <html> means nothing moves.
test("apply writes the flair attributes only while the master is on", () => {
  const off = styleStub();
  applyDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS }, off);
  assert.deepEqual(off.attrs, {});

  const on = styleStub();
  applyDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, flair: true, flairWave: false }, on);
  assert.deepEqual(on.attrs, {
    "data-flair": "",
    "data-flair-flame": "",
    "data-flair-frames": "",
    "data-flair-banner": "",
  });

  // Turning the master off again removes every sub-attribute, whatever the
  // sub-switches still say, so a rule never has to check both.
  applyDisplayPrefs({ ...DEFAULT_DISPLAY_PREFS, flair: false }, on);
  assert.deepEqual(on.attrs, {});
});

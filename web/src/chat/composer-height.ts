// Phase 91-1: composer height, as a user preference.
//
// The textarea has always had the browser's own resize grip in its corner.
// That grip writes an inline height that nothing remembers, and it is a 12px
// target in the one corner of the field -- so the divider above the composer
// is a drag handle too, and what it sets is a pref that follows the user to
// their other devices.
//
// 0 means "auto": no explicit height, so the field is the two rows it has
// always been at whatever the UI scale is. That is the default and what a
// reset returns to -- a px default would be wrong at every scale but one.

export const COMPOSER_HEIGHT_AUTO = 0;
export const COMPOSER_HEIGHT_MIN = 48;
export const COMPOSER_HEIGHT_MAX = 600;

// Keystroke resize step, shared by the resizer's arrow keys.
export const COMPOSER_HEIGHT_STEP = 16;

// clampComposerHeight coerces a stored height -- an older build's pref, a
// hand-edited value, a NaN out of a pointer computation -- into something the
// footer can render. Anything non-numeric or non-positive reads as auto, so a
// corrupt pref looks untouched rather than pinned to a bound.
export function clampComposerHeight(h: unknown): number {
  if (typeof h !== "number" || !Number.isFinite(h)) return COMPOSER_HEIGHT_AUTO;
  const px = Math.round(h);
  if (px <= 0) return COMPOSER_HEIGHT_AUTO;
  return Math.min(COMPOSER_HEIGHT_MAX, Math.max(COMPOSER_HEIGHT_MIN, px));
}

// composerHeightCeiling mirrors the 60dvh cap in theme.css. Both are needed:
// the CSS one stops a pref written on a tall monitor from eating a laptop
// screen, and this one stops the divider running away from a pointer the CSS
// has already halted.
export function composerHeightCeiling(viewportHeight: number): number {
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return COMPOSER_HEIGHT_MAX;
  const cap = Math.floor(viewportHeight * 0.6);
  return Math.max(COMPOSER_HEIGHT_MIN, Math.min(COMPOSER_HEIGHT_MAX, cap));
}

// clampComposerDrag bounds an in-flight drag. Unlike the stored value this one
// never collapses to auto: dragging the divider to the floor should leave a
// usable one-line field, not silently hand control back to the default.
export function clampComposerDrag(h: number, viewportHeight: number): number {
  if (!Number.isFinite(h)) return COMPOSER_HEIGHT_MIN;
  return Math.min(
    composerHeightCeiling(viewportHeight),
    Math.max(COMPOSER_HEIGHT_MIN, Math.round(h)),
  );
}

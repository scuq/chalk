// Phase 33-4: sidebar width, as a user preference.
//
// The sidebar used to be a hard-coded 220px column, which is too narrow for
// bracketed channel names like "[CORE] General" and too wide for someone who
// wants the message list to breathe. It is now a pref driving a CSS custom
// property on the app grid.
//
// The bounds are not cosmetic. Below the minimum the channel names ellipsise
// to nothing useful; above the maximum the message column starves, badly so
// when the thread panel is also open (it takes a fixed 340px of the same
// 1100px shell).

export const SIDEBAR_WIDTH_MIN = 160;
export const SIDEBAR_WIDTH_MAX = 420;
export const SIDEBAR_WIDTH_DEFAULT = 220;

// Keystroke resize step, shared by the resizer's arrow keys.
export const SIDEBAR_WIDTH_STEP = 16;

// clampSidebarWidth coerces anything -- a stale pref written by an older
// build, a hand-edited value, a NaN out of a pointer computation -- into a
// width the layout can actually render. Non-numeric input falls back to the
// default rather than to a bound, so a corrupt pref looks untouched instead
// of pinned to one extreme.
export function clampSidebarWidth(w: unknown): number {
  if (typeof w !== "number" || !Number.isFinite(w)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(w)));
}

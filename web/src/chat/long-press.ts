// 135-8: the long press on a phone list row, as constants and one pure
// rule. A press that is held this long opens the row's sheet. A finger
// that moves this far first is a scroll, not a press.

/** The time a press is held before the sheet opens, in milliseconds. */
export const LONG_PRESS_MS = 500;

/** The distance a finger can move and still count as a press, in pixels. */
export const LONG_PRESS_SLOP_PX = 10;

/** pressMoved reports whether a finger moved too far for a long press. */
export function pressMoved(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > LONG_PRESS_SLOP_PX;
}

// The long-press gesture's rules, with no DOM in them.
//
// Touch has no hover to reveal an affordance with, so several places fall back
// on a press: the message row's context menu, the roster's colour menu, and
// the reaction chip's "who reacted" card. They must all feel like the same
// gesture, which they only will if they share the same two numbers -- so the
// numbers live here rather than being retyped at each site.
//
// Same split as swipe-back.ts: the rules are pure and tested, the event
// plumbing stays in the component that owns the element.

/** How long a touch has to rest before it counts as a press. */
export const LONG_PRESS_MS = 500;

/** How far it may wander first.
 *
 * A finger is never perfectly still, so cancelling on any movement at all
 * would make the press unreliable; this is wide enough to survive a resting
 * hand and narrow enough that a scroll or a drag never opens anything. */
export const LONG_PRESS_SLOP_PX = 10;

export interface PressPoint {
  x: number;
  y: number;
}

/** Has the finger moved far enough that this is a scroll or a drag, not a
 *  press? */
export function pressWandered(origin: PressPoint, at: PressPoint): boolean {
  return Math.hypot(at.x - origin.x, at.y - origin.y) > LONG_PRESS_SLOP_PX;
}

// 64-3/64-4: the swipe-right-back gesture from a Zuckermode conversation
// to the list. Pure rules on touch coordinates so the gesture is testable
// without synthesizing TouchEvents; App owns the listeners and navigation.
//
// The first version armed only in a left-edge gutter, iOS-style. That
// never worked on actual iPhones: Safari reserves the screen edge for its
// own history gesture, so the page never reliably sees those touches. The
// swipe now arms anywhere in the conversation pane instead, and the rules
// below keep ordinary scrolling from navigating: triggering takes decisive
// rightward travel with clear horizontal dominance, and once vertical
// motion dominates the touch is dead for good -- a scroll that drifts
// sideways must not fire on the way through. Touches on horizontally
// pannable or draggable elements (code blocks, sliders) never arm at all;
// that check needs the DOM, so it lives with the listeners in App.

export const SWIPE_TRIGGER_PX = 64;
export const SWIPE_CANCEL_PX = 32;
// 64-6: a swipe starting near the right screen edge has less than
// SWIPE_TRIGGER_PX of glass left to travel -- the finger runs off the
// digitizer and the fixed threshold is unreachable, which made the gesture
// dead in roughly the rightmost sixth of the screen. Scale the trigger to
// the runway that actually exists, with a floor so an edge tap that wobbles
// a few pixels can never navigate.
export const SWIPE_TRIGGER_MIN_PX = 24;
// Only this fraction of the runway must be covered: the last touchmove
// arrives a little before the physical edge, so demanding the full runway
// would keep the trigger unreachable in exactly the zone this exists for.
const RUNWAY_FRACTION = 0.6;

export interface SwipeStart {
  x: number;
  y: number;
}

export function swipeTriggered(
  start: SwipeStart,
  x: number,
  y: number,
  viewportWidth: number,
): boolean {
  const dx = x - start.x;
  const dy = Math.abs(y - start.y);
  const runway = viewportWidth - start.x;
  const trigger = Math.max(
    SWIPE_TRIGGER_MIN_PX,
    Math.min(SWIPE_TRIGGER_PX, runway * RUNWAY_FRACTION),
  );
  return dx >= trigger && dx >= dy * 2;
}

export function swipeCancelled(start: SwipeStart, x: number, y: number): boolean {
  const dx = x - start.x;
  const dy = Math.abs(y - start.y);
  return dy >= SWIPE_CANCEL_PX && dy > dx;
}

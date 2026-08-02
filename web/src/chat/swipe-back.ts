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
// sideways must not fire on the way through. A touch on an element that has
// somewhere to pan (a strip already scrolled off its left edge, a slider)
// never arms at all; that check needs the DOM, so it lives in
// use-swipe-back.ts with the listeners.

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

// 64-12: the surface now follows the finger instead of jumping at the
// trigger, and the decision moved to the release. Two consequences for the
// rules here.
//
// First, tracking cannot start on the first pixel: a tap and the opening
// frames of a scroll both move sideways a little, and translating the whole
// screen for them would make the app twitch constantly. The gesture becomes
// visible only once the finger has said which way it is going.
export const SWIPE_ARM_PX = 12;
// Second, a fast flick is as decisive as a long drag and covers far less
// glass -- committing on distance alone would demand a stroke nobody has a
// reason to make. Speed counts, but only for a gesture that still travelled
// far enough not to be a tap (SWIPE_TRIGGER_MIN_PX).
export const SWIPE_FLICK_PX_PER_MS = 0.5;

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

// 64-12: has the finger committed to a rightward gesture? Same horizontal
// dominance the trigger demands, at the much shorter arming distance --
// past this point the surface starts moving with the touch.
export function swipeArmed(start: SwipeStart, x: number, y: number): boolean {
  const dx = x - start.x;
  const dy = Math.abs(y - start.y);
  return dx >= SWIPE_ARM_PX && dx >= dy * 2;
}

// How far the surface sits from its resting place. One-to-one with the
// finger and never leftward: the gesture only goes back.
export function swipeOffset(start: SwipeStart, x: number): number {
  return Math.max(0, x - start.x);
}

// The release decision: far enough, or fast enough.
export function swipeCommits(
  start: SwipeStart,
  x: number,
  y: number,
  viewportWidth: number,
  elapsedMs: number,
): boolean {
  if (swipeTriggered(start, x, y, viewportWidth)) return true;
  const dx = x - start.x;
  const dy = Math.abs(y - start.y);
  if (dx < SWIPE_TRIGGER_MIN_PX || dx < dy * 2) return false;
  return elapsedMs > 0 && dx / elapsedMs >= SWIPE_FLICK_PX_PER_MS;
}

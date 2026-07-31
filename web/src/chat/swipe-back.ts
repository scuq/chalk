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

export interface SwipeStart {
  x: number;
  y: number;
}

export function swipeTriggered(start: SwipeStart, x: number, y: number): boolean {
  const dx = x - start.x;
  const dy = Math.abs(y - start.y);
  return dx >= SWIPE_TRIGGER_PX && dx >= dy * 2;
}

export function swipeCancelled(start: SwipeStart, x: number, y: number): boolean {
  const dx = x - start.x;
  const dy = Math.abs(y - start.y);
  return dy >= SWIPE_CANCEL_PX && dy > dx;
}

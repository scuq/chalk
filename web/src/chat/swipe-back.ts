// 64-3: the iOS-style edge swipe back from a Zuckermode conversation to
// the list. Pure rules on touch coordinates so the gesture is testable
// without synthesizing TouchEvents; App owns the listeners and navigation.
//
// The gesture must start in the left-edge gutter -- a swipe from
// mid-screen is too easy to hit while panning something horizontal (a code
// block, a wide image) -- and must travel decisively rightward, twice as
// far sideways as any vertical drift, so a sloppy scroll doesn't navigate.

export const SWIPE_EDGE_PX = 32;
export const SWIPE_TRIGGER_PX = 64;

export interface SwipeStart {
  x: number;
  y: number;
}

// beginSwipe arms the gesture only for touches landing in the edge gutter;
// null means "not a back swipe, ignore the rest of this touch".
export function beginSwipe(x: number, y: number): SwipeStart | null {
  return x <= SWIPE_EDGE_PX ? { x, y } : null;
}

export function swipeTriggered(start: SwipeStart, x: number, y: number): boolean {
  const dx = x - start.x;
  const dy = Math.abs(y - start.y);
  return dx >= SWIPE_TRIGGER_PX && dx >= dy * 2;
}

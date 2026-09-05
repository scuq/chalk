// chalk 110-1 -- gallery rules for the lightbox: which image is next, and
// what a horizontal swipe means. Pure, so it is testable without
// synthesizing TouchEvents; Lightbox.tsx owns the listeners and the DOM.
//
// The gesture rules deliberately mirror 64-3's swipe-back (arm late, die on
// vertical dominance, commit on distance OR flick speed) but symmetric: the
// lightbox is the one surface where leftward travel means something. The
// constants are re-declared rather than imported because the two gestures
// are tuned against different surfaces and must be free to drift apart --
// a photo you are flicking through is not a screen you are backing out of.

/** The finger has said which way it is going; the image starts following. */
export const GALLERY_ARM_PX = 12;
/** Vertical dominance past this kills the touch for good (it was a scroll). */
export const GALLERY_CANCEL_PX = 32;
/** Travel that commits on distance alone. */
export const GALLERY_COMMIT_PX = 64;
/** A flick commits below GALLERY_COMMIT_PX, but never from a tap's wobble. */
export const GALLERY_FLICK_MIN_PX = 24;
export const GALLERY_FLICK_PX_PER_MS = 0.5;
/** Release animation, matched to SWIPE_SETTLE_MS so the app feels of a piece. */
export const GALLERY_SETTLE_MS = 160;

/**
 * What a committed swipe does. Rightward (`dir` +1) is "back": the previous
 * image, or -- at the first one, where there is nothing behind it -- out of
 * the lightbox entirely, which is how the 64-9 back gesture survives a
 * surface that now uses the same axis for navigation. Leftward is the next
 * image and nothing at the end of the set.
 */
export type SwipeAction = "prev" | "next" | "close" | "none";

/** stepIndex clamps rather than wraps: the ends of a set should feel like ends. */
export function stepIndex(index: number, count: number, delta: number): number {
  return Math.min(Math.max(index + delta, 0), Math.max(0, count - 1));
}

/** Has the finger committed to a horizontal gesture? */
export function swipeArmedX(dx: number, dy: number): boolean {
  return Math.abs(dx) >= GALLERY_ARM_PX && Math.abs(dx) >= Math.abs(dy) * 2;
}

/** A touch that turned into a vertical scroll is dead until the finger lifts. */
export function swipeCancelledX(dx: number, dy: number): boolean {
  return Math.abs(dy) >= GALLERY_CANCEL_PX && Math.abs(dy) > Math.abs(dx);
}

/** The release decision: far enough, or fast enough. 0 means neither. */
export function swipeCommitDir(dx: number, dy: number, elapsedMs: number): -1 | 0 | 1 {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < ay * 2) return 0;
  const dir = dx > 0 ? 1 : -1;
  if (ax >= GALLERY_COMMIT_PX) return dir;
  if (ax < GALLERY_FLICK_MIN_PX) return 0;
  if (elapsedMs > 0 && ax / elapsedMs >= GALLERY_FLICK_PX_PER_MS) return dir;
  return 0;
}

export function swipeActionFor(dir: -1 | 0 | 1, index: number, count: number): SwipeAction {
  if (dir === 0) return "none";
  if (dir > 0) return index > 0 ? "prev" : "close";
  return index < count - 1 ? "next" : "none";
}

/**
 * How far the image sits from centre while the finger is down. One-to-one
 * except where the swipe has nowhere to go -- past the last image it damps to
 * a third, so the set announces its own end instead of sliding into blank.
 * Rightward at the first image keeps full travel: that one leaves.
 */
export function swipeOffsetX(dx: number, index: number, count: number): number {
  if (dx < 0 && index >= count - 1) return dx / 3;
  return dx;
}

// 64-10/64-12: the swipe-right-back gesture, in one place.
//
// The rules live in swipe-back.ts (pure, testable without TouchEvents); this
// is the half that needs the DOM: which touches may arm the gesture, how far
// the surface has moved, and what happens when the finger lifts.
//
// It exists because the gesture used to be hand-wired into <main> alone, and
// every screen that arrived later -- the full-screen thread panel, the thread
// inbox, the lightbox -- either re-implemented it or, more often, simply
// swallowed the swipe. On a phone the thread panel covers everything
// including the header's back button, so "no gesture" meant the only way out
// of a thread was a 30px close button in the corner.
//
// The gesture tracks the finger and decides on release. The first version
// fired mid-drag at a fixed 64px, which was immediate but unreadable: below
// the threshold nothing acknowledged the touch, above it the screen changed
// under a finger that was still moving, and there was no way to change your
// mind. Following the finger costs a frame and makes both halves obvious.

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  swipeArmed,
  swipeCancelled,
  swipeCommits,
  swipeOffset,
  type SwipeStart,
} from "./swipe-back";

// The mobile drawer's transition (.chalk-sidebar), the one other surface on
// a phone that slides in and out. Same curve, same duration, so the two
// gestures feel like they belong to the same app.
export const SWIPE_SETTLE_MS = 160;

export interface SwipeBack {
  /**
   * Where the surface sits right now, in px. `null` means idle, and the
   * caller must then leave `transform` off entirely rather than write
   * translateX(0): any transform makes the element a containing block for
   * its position:fixed descendants, which would quietly move the message
   * menu and the lightbox off their anchors for the rest of the session.
   */
  offset: number | null;
  /** The release animation is running -- turn the transition on. */
  settling: boolean;
  onTouchStart: (e: TouchEvent) => void;
  onTouchMove: (e: TouchEvent) => void;
  onTouchEnd: (e: TouchEvent) => void;
  onTouchCancel: (e: TouchEvent) => void;
}

interface Options {
  /**
   * Keep the touches away from an ancestor that also listens. A lightbox
   * over the conversation has its own "back" and must not fire the
   * conversation's as well.
   */
  stopPropagation?: boolean;
}

export function useSwipeBack(
  enabled: boolean,
  onBack: () => void,
  { stopPropagation = false }: Options = {},
): SwipeBack {
  const startRef = useRef<(SwipeStart & { t: number }) | null>(null);
  const armedRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const [offset, setOffset] = useState<number | null>(null);
  const [settling, setSettling] = useState(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  // Run the surface to `to`, then drop back to idle and tell the caller.
  // Navigating after the animation rather than on release is deliberate:
  // the screen is visibly moving for those 160ms, so the delay reads as the
  // gesture completing rather than as lag.
  const settle = useCallback(
    (to: number, done?: () => void) => {
      clearTimer();
      setSettling(true);
      setOffset(to);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        setSettling(false);
        setOffset(null);
        done?.();
      }, SWIPE_SETTLE_MS);
    },
    [clearTimer],
  );

  const onTouchStart = useCallback(
    (e: TouchEvent) => {
      if (stopPropagation) e.stopPropagation();
      startRef.current = null;
      armedRef.current = false;
      // A finger landing during the release animation takes the surface
      // back: cut the animation short rather than fight it.
      if (timerRef.current !== null) {
        clearTimer();
        setSettling(false);
        setOffset(null);
      }
      if (!enabled) return;
      if (e.touches.length !== 1) return;
      // A touch on something the element itself will consume -- a strip
      // panned back from its left edge, a slider -- is for that element, not
      // for navigating back. Text fields keep their own selection gestures.
      //
      // 76-2: the test is scrollLeft, not "can this scroll at all". Being
      // scrollable is not the same as having somewhere to go: a code card's
      // snippet (.chalk-codecard-body, overflow-x: auto) overflows whenever
      // the code is wider than the phone, so the old test killed the gesture
      // over every code message even though the card sat at its left edge
      // with nothing to pan. Back is a rightward swipe, which can only
      // scroll an element leftward, so a scrollLeft of 0 leaves the gesture
      // free -- the same rule the platform's own edge-back follows.
      const root = e.currentTarget as HTMLElement | null;
      let el = e.target as HTMLElement | null;
      while (el && el !== root) {
        const tag = el.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        if (el.scrollLeft > 0) return;
        el = el.parentElement;
      }
      const t = e.touches[0];
      startRef.current = { x: t.clientX, y: t.clientY, t: e.timeStamp };
    },
    [clearTimer, enabled, stopPropagation],
  );

  const onTouchMove = useCallback(
    (e: TouchEvent) => {
      if (stopPropagation) e.stopPropagation();
      const start = startRef.current;
      if (!start) return;
      const t = e.touches[0];
      if (!t) return;
      // A touch that turned into a vertical scroll stays dead until the
      // finger lifts -- it must not fire on the way through a diagonal.
      if (swipeCancelled(start, t.clientX, t.clientY)) {
        const wasArmed = armedRef.current;
        startRef.current = null;
        armedRef.current = false;
        if (wasArmed) settle(0);
        return;
      }
      if (!armedRef.current && !swipeArmed(start, t.clientX, t.clientY)) return;
      armedRef.current = true;
      setOffset(swipeOffset(start, t.clientX));
    },
    [settle, stopPropagation],
  );

  const onTouchEnd = useCallback(
    (e: TouchEvent) => {
      if (stopPropagation) e.stopPropagation();
      const start = startRef.current;
      const wasArmed = armedRef.current;
      startRef.current = null;
      armedRef.current = false;
      if (!start || !wasArmed) return;
      const t = e.changedTouches[0];
      if (!t) {
        settle(0);
        return;
      }
      const commits = swipeCommits(
        start,
        t.clientX,
        t.clientY,
        window.innerWidth,
        e.timeStamp - start.t,
      );
      // Off the right edge on the way out, so the surface leaves rather
      // than snapping away.
      if (commits) settle(window.innerWidth, onBack);
      else settle(0);
    },
    [onBack, settle, stopPropagation],
  );

  const onTouchCancel = useCallback(
    (e: TouchEvent) => {
      if (stopPropagation) e.stopPropagation();
      const wasArmed = armedRef.current;
      startRef.current = null;
      armedRef.current = false;
      if (wasArmed) settle(0);
    },
    [settle, stopPropagation],
  );

  return { offset, settling, onTouchStart, onTouchMove, onTouchEnd, onTouchCancel };
}

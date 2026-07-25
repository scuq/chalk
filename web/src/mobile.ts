// chalk-web -- mobile viewport detection.
//
// The mobile layout itself is pure CSS (see the "mobile layout" section at
// the end of theme.css). This module exists for the parts CSS can't do:
// the roster drawer needs open/closed state, and that state must not leak
// into the desktop layout where the roster is a permanent column.
//
// The breakpoint is duplicated in theme.css -- CSS has no way to read a TS
// constant. Change both together.

import { useEffect, useState } from "preact/hooks";

export const MOBILE_MAX_WIDTH = 767;
export const MOBILE_QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

function matchesMobile(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia(MOBILE_QUERY).matches;
}

// useIsMobile tracks the phone-width media query. It re-renders on
// rotation and on desktop window resizes, so a layout that was mounted
// wide and then narrowed (or a phone turned sideways) stays consistent.
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(matchesMobile);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(MOBILE_QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", onChange);
    // The initial useState ran before mount; re-sync in case the viewport
    // changed in between (hydration, restored session, rotated device).
    setIsMobile(mq.matches);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isMobile;
}

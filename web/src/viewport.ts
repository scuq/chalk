// 125-1: keep the app shell inside whatever the phone keyboard leaves
// visible.
//
// Below the mobile breakpoint the shell is pinned to 100dvh so a short
// window scrolls inside the shell instead of pushing the composer off the
// bottom (see the 30-5j comment on .chalk-app in theme.css). iOS Safari
// breaks that assumption the moment the on-screen keyboard opens: the
// layout viewport and `dvh` both stay full-height, only the *visual*
// viewport shrinks, so the document ends up taller than what is actually
// visible and Safari scrolls the whole page up to keep the focused field
// in view. The channel header rides off the top with it, out of reach
// until the keyboard closes.
//
// The fix does not fight that scroll with layout math for a viewport iOS
// never reports honestly. It reads the visual viewport instead, which iOS
// does shrink correctly, and shrinks the shell -- and the page -- to
// match through a CSS custom property. With nothing left above the fold
// to scroll to, Safari has no reason to move the page, and a reset below
// undoes it on the rare case it does anyway.
import { useEffect } from "preact/hooks";

// The CSS custom property this module writes to <html>. theme.css falls
// back to 100dvh wherever it reads this, so a browser this module never
// activates on (desktop, or mobile without a visualViewport) is unaffected.
export const SHELL_HEIGHT_VAR = "--chalk-shell-h";

// Above this visualViewport.scale, treat the page as pinch-zoomed rather
// than keyboard-shrunk. A pinch-zoom also shrinks the visual viewport, and
// shrinking the shell to match would zoom the app chrome along with the
// content instead of just panning it. The margin over 1 absorbs the
// sub-pixel scale jitter some browsers report at rest.
const ZOOMED_SCALE = 1.01;

// shellHeight returns the pixel height the app shell should take, given
// the current visualViewport reading and the layout viewport's
// innerHeight. It reports innerHeight -- the ordinary, full-height case --
// when visualHeight is not a usable number, or when visualScale shows the
// page is pinch-zoomed rather than keyboard-shrunk. Otherwise it reports
// the rounded visualHeight, never more than innerHeight, so a momentary
// visualViewport reading larger than the layout viewport can't grow the
// shell past its normal bound.
export function shellHeight(
  visualHeight: number | undefined,
  visualScale: number | undefined,
  innerHeight: number,
): number {
  const zoomed = typeof visualScale === "number" && visualScale > ZOOMED_SCALE;
  const usable =
    !zoomed && typeof visualHeight === "number" && Number.isFinite(visualHeight) && visualHeight > 0;
  if (!usable) return Math.round(innerHeight);
  return Math.round(innerHeight > 0 ? Math.min(visualHeight, innerHeight) : visualHeight);
}

// useKeyboardSafeShell writes SHELL_HEIGHT_VAR while active and a
// visualViewport exists, and removes it otherwise, on unmount, and while
// inactive -- so the desktop layout, which never calls this with
// active true, is never touched. It re-derives the value on every
// visualViewport resize and scroll event, throttled to one
// requestAnimationFrame so a run of events writes the property at most
// once per frame. When the page is not zoomed and the window has
// scrolled -- iOS Safari's own reaction to the focused field -- it resets
// the scroll position to zero, since a shell already sized to the visible
// area gives Safari nothing left to scroll to.
export function useKeyboardSafeShell(active: boolean): void {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const root = document.documentElement;
    const vv = window.visualViewport;
    if (!active || !vv) {
      root.style.removeProperty(SHELL_HEIGHT_VAR);
      return;
    }
    let frame = 0;
    const sync = () => {
      frame = 0;
      // CSSOM, not a style attribute in markup: chalk's style-src stays
      // strict, and this is the write path it still allows.
      root.style.setProperty(SHELL_HEIGHT_VAR, `${shellHeight(vv.height, vv.scale, window.innerHeight)}px`);
      if (vv.scale <= ZOOMED_SCALE && window.scrollY !== 0) window.scrollTo(0, 0);
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(sync);
    };
    sync();
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    return () => {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      vv.removeEventListener("resize", schedule);
      vv.removeEventListener("scroll", schedule);
      root.style.removeProperty(SHELL_HEIGHT_VAR);
    };
  }, [active]);
}

// Pop-out window: chalk in its own right-sized browser window.
//
// The pop-out is identified by its browsing-context name, which window.open
// assigns when we spawn it. window.opener alone is not a reliable marker:
// browsers null it once the opening tab is closed, and it does not survive a
// session restore -- in both cases the pop-out would start offering to pop
// itself out again. The name survives all of that, and reusing it also means
// a second click on the button raises the existing window instead of
// spawning a second one.

export const POPOUT_NAME = "chalk-popout";

const MAX_W = 1200;
const MAX_H = 860;

export function isPopoutWindow(w: Window | undefined = typeof window === "undefined" ? undefined : window): boolean {
  if (!w) return false;
  return w.name === POPOUT_NAME || w.opener != null;
}

export function openPopout(w: Window = window): void {
  const width = Math.min(MAX_W, w.screen.availWidth);
  const height = Math.min(MAX_H, w.screen.availHeight);
  const left = Math.max(0, Math.round((w.screen.availWidth - width) / 2));
  const top = Math.max(0, Math.round((w.screen.availHeight - height) / 2));
  // No noopener: the child is same-origin, and keeping the opener link is
  // what lets an already-open pop-out be raised rather than duplicated.
  const child = w.open(
    w.location.href,
    POPOUT_NAME,
    `popup=yes,width=${width},height=${height},left=${left},top=${top}`,
  );
  child?.focus();
}

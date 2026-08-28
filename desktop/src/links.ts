// chalk-desktop -- where a navigation is allowed to go.
//
// 104-1: the shell shows exactly one origin, the chalk server. Everything
// the page tries to open is sorted into four bins:
//
//   in-app    same origin as the server -- join links, /admin, the
//             normal SPA routes. Stays in the window.
//   child     about:blank pop-ups the client opens to write into itself:
//             the recovery-phrase print window (IdentitySetupScreen) and
//             the pop-out call window (voice/pip.ts). They inherit the
//             opener's origin and need a real child window, not a browser.
//   external  any other http(s)/mailto -- a link someone pasted. Handed to
//             the operating system's default browser, which is the whole
//             point of requirement 3 in the phase doc: a PWA installed in
//             a non-default browser cannot do this.
//   deny      everything else (file:, javascript:, custom schemes).
//
// Pure, so it is tested; main.ts wires it to will-navigate and
// setWindowOpenHandler.

export type LinkAction = "in-app" | "child" | "external" | "deny";

export function classifyLink(target: string, serverOrigin: string | null): LinkAction {
  if (target === "" || target === "about:blank") return "child";
  let u: URL;
  try {
    u = new URL(target);
  } catch {
    return "deny";
  }
  if (u.protocol === "http:" || u.protocol === "https:") {
    if (serverOrigin !== null && u.origin === serverOrigin) return "in-app";
    return "external";
  }
  if (u.protocol === "mailto:") return "external";
  return "deny";
}

/** originOf returns the origin of a server URL, or null when it has none. */
export function originOf(url: string | null): string | null {
  if (url === null) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The part of a window.open() features string a pop-up's window should
 * honour. Unset when the page named nothing. */
export interface PopupGeometry {
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

/** Smallest and largest window a page may ask for, so a stray value cannot
 * open a pinhole or something larger than any screen. */
const POPUP_MIN = 100;
const POPUP_MAX = 8192;

/**
 * 104-6: parseWindowFeatures reads width/height/left/top out of the third
 * argument to window.open(), the way a browser does. The pop-out call
 * window (voice/pip.ts) sizes itself to the video's own aspect ratio and
 * cascades several at once; before this every child got one fixed
 * portrait size. Anything malformed or out of range is simply absent, so
 * the caller's defaults apply.
 */
export function parseWindowFeatures(features: string | undefined): PopupGeometry {
  const out: PopupGeometry = {};
  if (!features) return out;
  for (const item of features.split(",")) {
    const eq = item.indexOf("=");
    if (eq < 0) continue;
    const key = item.slice(0, eq).trim().toLowerCase();
    const n = Number(item.slice(eq + 1).trim());
    if (!Number.isInteger(n)) continue;
    if (key === "width" || key === "height") {
      if (n >= POPUP_MIN && n <= POPUP_MAX) out[key] = n;
    } else if (key === "left" || key === "top") {
      if (n >= 0 && n <= POPUP_MAX) out[key === "left" ? "x" : "y"] = n;
    }
  }
  return out;
}

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

// chalk-desktop -- what the page may ask the operating system for.
//
// 104-1: in a browser these are prompts; in the shell they are a policy,
// because the user already chose to run chalk as an app. The policy is
// deliberately short and scoped to the server origin -- a pop-up, a
// redirect or a mistaken external page gets nothing.
//
// Pure decision, tested; main.ts installs it on the session.

const ALLOWED = new Set<string>([
  // getUserMedia: mic and camera. Chromium asks once per call with both
  // kinds in one request (voice/call.ts asks for them together on purpose).
  "media",
  // getDisplayMedia goes through setDisplayMediaRequestHandler, but the
  // permission check still runs first.
  "display-capture",
  // notify/banners.ts, `new Notification(...)` from the page.
  "notifications",
  // navigator.clipboard.writeText (copy-invite, copy-code).
  "clipboard-sanitized-write",
  // Composer paste of images reads the clipboard.
  "clipboard-read",
  // The call stage's fullscreen button.
  "fullscreen",
  // presence/system-idle.ts, on Chromium-based shells. Harmless to allow
  // even though slice 104-3 supersedes it with the shell's own signal.
  "idle-detection",
  // <audio>/<video> autoplay for notification sounds and remote tracks.
  "mediaKeySystem",
]);

export function permissionAllowed(
  permission: string,
  requestingOrigin: string | null,
  serverOrigin: string | null,
): boolean {
  if (serverOrigin === null || requestingOrigin === null) return false;
  if (requestingOrigin !== serverOrigin) return false;
  return ALLOWED.has(permission);
}

/** originOfURL is `new URL(u).origin` without the throw. */
export function originOfURL(u: string | undefined): string | null {
  if (!u) return null;
  try {
    return new URL(u).origin;
  } catch {
    return null;
  }
}

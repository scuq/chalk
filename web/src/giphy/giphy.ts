// att-4: Giphy URL-reference support (client core).
//
// chalk's privacy invariant for Giphy: a GIF is sent as a URL inside the
// normal E2E-encrypted body; the server only ever sees ciphertext. Each
// VIEWER independently decides whether to fetch-and-render that URL from
// Giphy's CDN, based on THEIR OWN opt-in pref. So one member enabling Giphy
// never causes another member's browser to phone home.
//
// This module is the pure, framework-free core: the consent pref shape, the
// on-the-wire marker that distinguishes a Giphy message from a user who
// merely typed a giphy.com link, the CDN host allowlist (a SECURITY control
// against a malicious sender turning the render path into an IP-grabber), and
// the render-decision function. All side-effect-free and unit-tested; the
// components build on top (consent modal + settings toggle here in att-4b;
// the gated <img> render and the picker in att-4c).

import type { UserPrefs } from "../state/types";

// ---- consent pref (tri-state) -----------------------------------------

export type GiphyPref = "unset" | "enabled" | "disabled";

// selectGiphyPref resolves the (possibly absent) prefs.giphy to the tri-state,
// defaulting to "unset". Mirrors selectChatPrefs: pure, safe to call inline.
export function selectGiphyPref(prefs: UserPrefs | undefined): GiphyPref {
  const v = prefs?.giphy;
  return v === "enabled" || v === "disabled" ? v : "unset";
}

// ---- on-the-wire marker -----------------------------------------------

// GIPHY_SENTINEL prefixes the plaintext body of a Giphy message. The two
// U+0001 (Start-of-Heading) controls bracket a version-tagged token; users
// don't type control chars, so this can't collide with ordinary text, and
// it's an EXPLICIT marker rather than fragile URL-sniffing of arbitrary
// bodies. The Giphy URL follows immediately after.
//
// Wire form:  \u0001chalk:giphy:v1\u0001<url>
export const GIPHY_SENTINEL = "\u0001chalk:giphy:v1\u0001";

// encodeGiphyBody builds the plaintext body for a Giphy message. The caller
// encrypts the result exactly like any other body. url MUST already be an
// allowlisted Giphy CDN URL (the att-4c picker only yields such URLs).
export function encodeGiphyBody(url: string): string {
  return GIPHY_SENTINEL + url;
}

// parseGiphyBody returns the embedded URL if body is a Giphy message, else
// null. Pure string check; performs no fetching and no host validation
// (callers apply isAllowedGiphyURL before rendering).
export function parseGiphyBody(body: string): { url: string } | null {
  if (!body.startsWith(GIPHY_SENTINEL)) return null;
  const url = body.slice(GIPHY_SENTINEL.length);
  if (url === "") return null;
  return { url };
}

// ---- CDN host allowlist (security control) ----------------------------

// GIPHY_ALLOWED_HOSTS is the exact set of hosts a Giphy render may fetch
// from. Defense-in-depth: even an "enabled" viewer never fetches a non-Giphy
// host, so a malicious sender can't smuggle an arbitrary URL through the
// giphy marker to grab the viewer's IP or probe internal hosts. Giphy serves
// GIFs from media0..media4.giphy.com and i.giphy.com.
const GIPHY_ALLOWED_HOSTS = new Set<string>([
  "media.giphy.com",
  "media0.giphy.com",
  "media1.giphy.com",
  "media2.giphy.com",
  "media3.giphy.com",
  "media4.giphy.com",
  "i.giphy.com",
]);

// isAllowedGiphyURL reports whether url is safe to render as a Giphy <img>:
// a well-formed https URL whose host is in the allowlist. Any parse failure,
// non-https scheme, or unlisted host => false (fail closed).
export function isAllowedGiphyURL(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return GIPHY_ALLOWED_HOSTS.has(u.hostname.toLowerCase());
}

// ---- render decision (the privacy invariant, as a pure function) ------

export type GiphyRender =
  | { mode: "text" } // not a giphy message: render body as plain text
  | { mode: "image"; url: string } // enabled + allowlisted: fetch & show <img>
  | { mode: "blocked"; url: string; reason: "disabled" | "unset" | "bad_host" };

// decideGiphyRender is the single source of truth for what a received body
// becomes. It NEVER fetches; it only classifies. The caller renders:
//   - "text":    plain body (today's behavior; also every non-giphy message).
//   - "image":   an <img> from url -- the ONLY fetch point, reached only when
//                the LOCAL viewer enabled Giphy AND the host is allowlisted.
//   - "blocked": inert, selectable text of the url, never fetched. reason lets
//                the UI offer "enable Giphy" (unset) or a settings hint
//                (disabled), or silently degrade a non-allowlisted host.
//
// Two-sided gating falls out of this: rendering is gated on the VIEWER's own
// pref, independent of who sent it. A non-consenting viewer leaks nothing even
// in a channel full of Giphy users.
export function decideGiphyRender(body: string, pref: GiphyPref): GiphyRender {
  const parsed = parseGiphyBody(body);
  if (!parsed) return { mode: "text" };
  if (pref !== "enabled") {
    return {
      mode: "blocked",
      url: parsed.url,
      reason: pref === "disabled" ? "disabled" : "unset",
    };
  }
  if (!isAllowedGiphyURL(parsed.url)) {
    return { mode: "blocked", url: parsed.url, reason: "bad_host" };
  }
  return { mode: "image", url: parsed.url };
}

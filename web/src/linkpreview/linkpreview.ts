// 57-2: link-preview support (client core). See docs/PHASE-57-LINKPREVIEW.md.
//
// chalk's privacy model for previews is the reverse of Giphy's: the SENDER
// builds the preview (their client asks their own chalkd to fetch the page)
// and embeds the result inside the E2E-encrypted body. Recipients render the
// card from decrypted data and never fetch anything, so no recipient consent
// is needed for network privacy -- the tri-state pref gates SENDER-side
// generation, and a separate display pref merely hides received cards.
//
// This module is the pure, framework-free core: the consent pref shape, the
// on-the-wire marker + payload schema, receive-side payload sanitizing (the
// payload is sender-asserted, i.e. hostile input), the whitelist matcher
// (server default list + per-user overrides), and the compose/render decision
// functions. The components build on top (composer card + consent modal in
// 57-3; the received card and settings in 57-4).

import type { UserPrefs } from "../state/types";

// ---- consent pref (tri-state) -----------------------------------------

export type LinkPreviewPref = "unset" | "enabled" | "disabled";

// selectLinkPreviewPref resolves the (possibly absent) prefs.linkpreview to
// the tri-state, defaulting to "unset". Mirrors selectGiphyPref.
export function selectLinkPreviewPref(prefs: UserPrefs | undefined): LinkPreviewPref {
  const v = prefs?.linkpreview;
  return v === "enabled" || v === "disabled" ? v : "unset";
}

// ---- domain whitelist --------------------------------------------------

// The server's default list arrives via /api/auth/config
// (linkpreview_domains); the user may remove entries or add their own
// (prefs.linkpreviewDomains). The result only ever controls which pastes
// auto-offer a preview on THIS user's compose side -- the SSRF boundary is
// server-side in internal/linkpreview.
export function effectiveLinkPreviewDomains(
  serverDomains: string[] | undefined,
  prefs: UserPrefs | undefined,
): string[] {
  const removed = new Set(normalizeDomains(prefs?.linkpreviewDomains?.removed));
  const out: string[] = [];
  for (const d of [
    ...normalizeDomains(serverDomains),
    ...normalizeDomains(prefs?.linkpreviewDomains?.added),
  ]) {
    if (!removed.has(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

function normalizeDomains(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const d of list) {
    if (typeof d !== "string") continue;
    const t = d.trim().toLowerCase();
    if (t !== "" && !/[\s/:@?#]/.test(t)) out.push(t);
  }
  return out;
}

// isWhitelistedURL reports whether url is a well-formed https URL whose host
// is one of domains or a subdomain of one ("youtube.com" matches
// "www.youtube.com" but never "notyoutube.com"). Fail closed.
export function isWhitelistedURL(url: string, domains: string[]): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return false;
  const host = u.hostname.toLowerCase();
  return domains.some((d) => host === d || host.endsWith("." + d));
}

// findPreviewableURL returns the first https URL in text whose host is
// whitelisted, or null. Trailing punctuation a sentence would glue onto a
// pasted link is stripped before matching.
export function findPreviewableURL(text: string, domains: string[]): string | null {
  for (const m of text.matchAll(/https:\/\/\S+/g)) {
    const url = m[0].replace(/[.,;:!?)\]>'"]+$/, "");
    if (isWhitelistedURL(url, domains)) return url;
  }
  return null;
}

// ---- on-the-wire marker + payload -------------------------------------

// LINKPREVIEW_SENTINEL prefixes the plaintext body of a message carrying a
// preview. Same construction as GIPHY_SENTINEL: U+0001 controls bracket a
// version-tagged token, unambiguous against typed text. Unlike Giphy, a
// preview ACCOMPANIES normal text, so the payload JSON is terminated by one
// more U+0001 and the user's message text follows:
//
// Wire form:  \u0001chalk:linkpreview:v1\u0001<payload json>\u0001<text>
//
// JSON.stringify escapes control characters, so the payload can never
// contain a literal U+0001 -- the terminator scan is unambiguous.
export const LINKPREVIEW_SENTINEL = "\u0001chalk:linkpreview:v1\u0001";

// Field caps, matching the server's (internal/linkpreview). Applied on BOTH
// encode and parse: the payload arrives inside E2E ciphertext, so the server
// never had a chance to cap what a hostile sender embedded.
export const LINKPREVIEW_MAX_TITLE = 300;
export const LINKPREVIEW_MAX_DESC = 500;
export const LINKPREVIEW_MAX_SITE = 100;

export interface LinkPreviewPayload {
  url: string; // the real destination; the card must always show its host
  title: string;
  description: string;
  site_name: string;
  // E2E-encrypted thumbnail, uploaded through the normal attachment
  // pipeline by the sender (57-3). Absent = text-only card.
  attachment_id?: string;
  image_w?: number;
  image_h?: number;
}

// encodeLinkPreviewBody builds the plaintext body for a message carrying a
// preview. The caller encrypts the result exactly like any other body.
export function encodeLinkPreviewBody(preview: LinkPreviewPayload, text: string): string {
  const clean = sanitizeLinkPreviewPayload(preview);
  if (!clean) return text;
  return LINKPREVIEW_SENTINEL + JSON.stringify(clean) + "\u0001" + text;
}

// parseLinkPreviewBody returns the embedded preview + the accompanying text
// if body carries a valid preview, else null (callers render body as plain
// text). Performs no fetching; sanitizes every field.
export function parseLinkPreviewBody(
  body: string,
): { preview: LinkPreviewPayload; text: string } | null {
  if (!body.startsWith(LINKPREVIEW_SENTINEL)) return null;
  const rest = body.slice(LINKPREVIEW_SENTINEL.length);
  const end = rest.indexOf("\u0001");
  if (end < 0) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(rest.slice(0, end));
  } catch {
    return null;
  }
  const preview = sanitizeLinkPreviewPayload(raw);
  if (!preview) return null;
  return { preview, text: rest.slice(end + 1) };
}

// sanitizeLinkPreviewPayload validates a sender-asserted payload into a
// well-formed one, or null if it has no usable core (bad url, or nothing to
// show). Unknown fields are dropped, strings are capped, dimensions are
// bounded -- a hostile payload can degrade to plain text, never to broken UI.
export function sanitizeLinkPreviewPayload(raw: unknown): LinkPreviewPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;

  if (typeof o.url !== "string") return null;
  let u: URL;
  try {
    u = new URL(o.url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return null;

  const title = capString(o.title, LINKPREVIEW_MAX_TITLE);
  const description = capString(o.description, LINKPREVIEW_MAX_DESC);
  const site_name = capString(o.site_name, LINKPREVIEW_MAX_SITE);
  const attachment_id = cleanAttachmentID(o.attachment_id);
  if (title === "" && description === "" && attachment_id === undefined) return null;

  const out: LinkPreviewPayload = { url: u.toString(), title, description, site_name };
  if (attachment_id !== undefined) {
    out.attachment_id = attachment_id;
    const w = cleanDimension(o.image_w);
    const h = cleanDimension(o.image_h);
    if (w !== undefined && h !== undefined) {
      out.image_w = w;
      out.image_h = h;
    }
  }
  return out;
}

// capString caps by code points (the server caps by runes; keep them equal).
function capString(v: unknown, max: number): string {
  if (typeof v !== "string") return "";
  const t = v.trim();
  const cp = [...t];
  return cp.length <= max ? t : cp.slice(0, max).join("");
}

function cleanAttachmentID(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  return /^[A-Za-z0-9_-]{1,128}$/.test(v) ? v : undefined;
}

function cleanDimension(v: unknown): number | undefined {
  if (typeof v !== "number" || !Number.isInteger(v)) return undefined;
  return v >= 1 && v <= 8192 ? v : undefined;
}

// ---- compose decision --------------------------------------------------

export type LinkPreviewOffer =
  | { mode: "none" } // no whitelisted url, or the user said no
  | { mode: "consent"; url: string } // first use: raise the consent modal
  | { mode: "generate"; url: string }; // fetch metadata and show the card

// decideLinkPreviewOffer is the compose-side gate: whether typing/pasting
// text should offer a preview. It NEVER fetches; the 57-3 composer acts on
// "generate" (call /api/linkpreview) or "consent" (modal first).
export function decideLinkPreviewOffer(
  text: string,
  pref: LinkPreviewPref,
  domains: string[],
): LinkPreviewOffer {
  if (pref === "disabled") return { mode: "none" };
  const url = findPreviewableURL(text, domains);
  if (url === null) return { mode: "none" };
  if (pref === "unset") return { mode: "consent", url };
  return { mode: "generate", url };
}

// ---- render decision ---------------------------------------------------

export type LinkPreviewRender =
  | { mode: "text" } // not a preview message: render body as plain text
  | { mode: "preview"; preview: LinkPreviewPayload; text: string }
  | { mode: "hidden"; text: string }; // viewer hides cards: text only

// decideLinkPreviewRender classifies a received body. No viewer consent
// gate here -- rendering a card costs zero network requests; hideCards is
// the 57-4 display pref for viewers who just don't want cards.
export function decideLinkPreviewRender(body: string, hideCards: boolean): LinkPreviewRender {
  const parsed = parseLinkPreviewBody(body);
  if (!parsed) return { mode: "text" };
  if (hideCards) return { mode: "hidden", text: parsed.text };
  return { mode: "preview", preview: parsed.preview, text: parsed.text };
}

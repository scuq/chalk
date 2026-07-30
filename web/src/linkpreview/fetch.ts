// 57-3: HTTP client for the link-preview fetcher (internal/linkpreview).
//
// The SENDER's client calls these for a URL it is about to send; the results
// are embedded in the E2E-encrypted body (and the thumbnail re-uploaded as an
// encrypted attachment), so recipients never call anything here. Both
// endpoints ride the session cookie like every other /api call. Failures
// degrade to "no preview" -- a preview is decoration, never worth blocking a
// send over, so callers get null instead of exceptions.

import { type LinkPreviewPayload, sanitizeLinkPreviewPayload } from "./linkpreview";

// FetchedPreview separates what gets EMBEDDED (payload) from what is only
// used sender-side to build the thumbnail attachment (imageURL, which points
// at the third-party CDN and must never ride into the message).
export interface FetchedPreview {
  payload: LinkPreviewPayload;
  imageURL: string | null;
}

// fetchLinkPreview asks chalkd for a page's OpenGraph metadata. Returns null
// on any failure or when the page yields nothing worth showing.
export async function fetchLinkPreview(url: string): Promise<FetchedPreview | null> {
  let resp: Response;
  try {
    resp = await fetch(`/api/linkpreview?url=${encodeURIComponent(url)}`, {
      credentials: "same-origin",
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  let raw: unknown;
  try {
    raw = await resp.json();
  } catch {
    return null;
  }
  // The server echoes the FINAL url (post-redirect); prefer the one the user
  // actually typed so the card names the destination they can see in their
  // draft. Sanitize exactly like a received payload -- same caps, same rules.
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const payload = sanitizeLinkPreviewPayload({
    url,
    title: o.title,
    description: o.description,
    site_name: o.site_name,
  });
  const imageURL = typeof o.image_url === "string" && o.image_url !== "" ? o.image_url : null;
  // A page with only an image is still a preview; sanitize refuses a payload
  // with no text, so re-admit it as title-less only when a thumb exists.
  if (!payload && imageURL === null) return null;
  if (!payload) {
    const withStub = sanitizeLinkPreviewPayload({ url, title: hostOf(url) });
    if (!withStub) return null;
    return { payload: withStub, imageURL };
  }
  return { payload, imageURL };
}

// fetchLinkPreviewThumb pulls the thumbnail bytes through chalkd. Returns a
// Blob typed with the upstream content type, or null on any failure.
export async function fetchLinkPreviewThumb(imageURL: string): Promise<Blob | null> {
  let resp: Response;
  try {
    resp = await fetch(`/api/linkpreview/image?url=${encodeURIComponent(imageURL)}`, {
      credentials: "same-origin",
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  const blob = await resp.blob().catch(() => null);
  if (!blob || !blob.type.startsWith("image/")) return null;
  return blob;
}

// linkPreviewThumbFilename names the thumbnail attachment. The "linkpreview."
// prefix is the CONVENTION that links a message's preview payload to its
// thumbnail: the renderer (57-4) shows an image attachment with this name
// inside the card instead of as a normal attachment row.
export const LINKPREVIEW_THUMB_PREFIX = "linkpreview.";

export function linkPreviewThumbFilename(mime: string): string {
  const ext =
    { "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" }[
      mime
    ] ?? "img";
  return LINKPREVIEW_THUMB_PREFIX + ext;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

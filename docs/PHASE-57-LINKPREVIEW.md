# Phase 57 — link previews

Opt-in link preview cards for pasted URLs (YouTube, Steam by default),
without breaking the E2E privacy model. Planned against v0.4.7.

## The problem

A pasted YouTube or Steam link renders as bare text. Every other chat shows
a title/thumbnail card — but the naive ways to build one are exactly the
ways E2E chats leak metadata:

- **Recipient-side fetch** (each viewer pulls OpenGraph data): every
  channel member's browser pings the linked site the moment the message
  renders. A malicious sender gets an IP beacon per viewer. Rejected.
- **Server auto-unfurl**: impossible (bodies are ciphertext) and would
  break the blind-relay invariant if it weren't. Rejected.
- **Direct client fetch of the page**: blocked twice — the target sites
  don't serve CORS, and our own `connect-src 'self'` CSP (51-1). Rejected.

## Design: sender-generated, E2E-embedded (the Signal model)

When the *sender* pastes a whitelisted URL, their client asks chalkd to
fetch the page and extract OpenGraph metadata, shows a dismissible preview
card in the composer, and embeds the result — title, description,
thumbnail — **inside the E2E-encrypted body**, marked by a sentinel exactly
like `GIPHY_SENTINEL` (att-4). Recipients render the card from decrypted
data and make **zero network requests**.

Privacy accounting:

- The only party that learns the URL-being-previewed is the user's own
  self-hosted chalkd — the same trust carve-out Giphy search already makes
  (chalkd sees search terms). It learns the URL and the requesting user,
  never the channel or recipients.
- Only the sender's action triggers a fetch, for a URL they were about to
  publish to the channel anyway.
- Recipients leak nothing, ever. No recipient consent is needed for
  network privacy; a display-only "hide preview cards" pref is offered
  anyway.
- The thumbnail is downloaded through chalkd by the *sender*, then
  re-uploaded through the existing E2E attachment pipeline and referenced
  from the preview payload. Recipients never touch a CDN, **CSP stays
  exactly as-is** (no third-party `img-src`), and user-added whitelist
  domains work without CSP changes — a remote-URL design could never
  support them, since CSP is server-controlled.

Honest limitation (same as Signal): preview content is sender-asserted. A
malicious sender can ship a title/thumbnail that doesn't match the link.
Mitigations: the card always displays the real destination host
prominently, preview text renders as text (never HTML), and payload fields
are length-capped on the receiving side.

## The whitelist

- **Default, shipped by chalk**: `youtube.com`, `www.youtube.com`,
  `m.youtube.com`, `youtu.be`, `store.steampowered.com`,
  `steamcommunity.com`. Lives in server config, served to the SPA via
  `GET /api/auth/config` (`linkpreview_domains`), so updates arrive with
  server upgrades.
- **Admin override**: `CHALK_LINKPREVIEW_DOMAINS` (comma-separated)
  replaces the default list; `CHALK_LINKPREVIEW_ENABLED=false` kills the
  feature (route answers 503, SPA hides everything). Both wired through
  chalkctl.
- **Per-user override**: settings let a user disable domains from the
  server list or add their own. A match means "auto-offer a preview when I
  paste this"; it only ever affects the user's *own sender-side*
  generation.

The whitelist is a consent/UX control, **not** the security boundary. Once
users can add domains, the proxy must survive arbitrary URLs anyway, so the
real boundary is SSRF hardening in the fetcher (below). Subdomain matching:
a whitelist entry matches the host itself or any subdomain
(`youtube.com` matches `www.youtube.com`).

## The fetcher (internal/linkpreview)

`GET /api/linkpreview?url=` (metadata JSON) and
`GET /api/linkpreview/image?url=` (thumbnail bytes), both session-gated.
Hardening, all of it mandatory:

- https only; URL must parse; no credentials/userinfo in the URL.
- **IP vetting at dial time** via `net.Dialer.Control`: the vetted address
  is the exact one being connected to (DNS-rebinding safe), and redirects
  re-dial through the same guard. Rejected: loopback, RFC1918, link-local
  (v4 + v6), CGNAT 100.64/10, ULA fc00::/7, multicast, unspecified, and
  the other special-purpose ranges. Fail closed.
- Max 3 redirects; response caps 1 MiB HTML / 5 MiB image; short timeout
  (`CHALK_LINKPREVIEW_TIMEOUT_SECONDS`, default 8).
- Content-type enforced: `text/html` for pages, `image/*` for thumbnails.
- No cookies sent or stored; generic `chalkd-linkpreview` User-Agent.
- Per-user rate limit (20 fetches/min) so an authed user can't turn chalkd
  into a crawling proxy.

Metadata extraction is OpenGraph only (`og:title`, `og:description`,
`og:image`, `og:site_name`, with `<title>`/meta-description fallback) via a
small hand-rolled meta-tag scanner on stdlib — YouTube and Steam both serve
OG tags server-side; no oEmbed, no HTML-parsing dependency, no JS
execution. UTF-8 assumed. If a page yields no usable metadata the endpoint
returns an empty-fields preview and the composer simply offers nothing.

## On-the-wire format

    chalk:linkpreview:v1<json><message text>

The JSON payload: `{url, title, description, site_name, attachment_id?,
image_w?, image_h?}` where `attachment_id` references the E2E-encrypted
thumbnail. Unlike Giphy (whole body is the GIF), a preview *accompanies*
normal text, so the marker prefixes the body and the text follows after the
closing control char. Receivers must treat the payload as hostile input:
parse failure → render body as plain text; field length caps; unknown
fields ignored (forward compat).

## Opt-in (the Giphy consent pattern)

Tri-state `linkpreview` pref in `UserPrefs` (`unset`/`enabled`/`disabled`),
mirroring `selectGiphyPref`. Off until answered. First paste of a
whitelisted URL raises a consent modal: "chalk will ask *your* server to
fetch this page to build a preview — the server sees the URL, the site sees
only the server." Settings toggle lives beside the Giphy one. Every
generated preview is shown in the composer first and is dismissible per
message before send.

## Slices

- **57-1 (server)**: `LinkPreviewConfig` (`CHALK_LINKPREVIEW_*`) +
  chalkctl wiring; `internal/linkpreview` fetcher with the SSRF guards, OG
  scanner, rate limiter; `/api/linkpreview` + `/api/linkpreview/image`
  routes; `linkpreview_enabled` + `linkpreview_domains` in
  `/api/auth/config`. No client change; no changelog yet.
- **57-2 (client core)**: pure module `web/src/linkpreview/` — sentinel
  encode/parse/validate, host-whitelist matching (server list + user
  overrides), pref selector. Unit-tested like `giphy.ts`.
- **57-3 (composer)**: URL detection on paste/type-pause, consent modal,
  preview card with dismiss, thumbnail fetch → encrypt → attachment
  upload, payload embedding on send.
- **57-4 (render + settings)**: recipient-side card in MessageList (text
  from payload, thumbnail via the attachment pipeline, real host shown),
  settings UI (toggle, per-domain overrides, hide-cards display pref).
  Changelog bullet lands here.

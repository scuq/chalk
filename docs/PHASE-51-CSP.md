# Phase 51 — content security policy and security headers

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.4.3. Superseded in scope by the phase-81 audit for
everything *behind* the headers.
**Tag:** `#hardening` → `tools/where.sh -g hardening`

## Why

chalk decrypts everything in the browser. That makes the page itself the
security boundary: anything that can run script in it, or frame it, or read a
one-time token out of a URL, gets the plaintext. Headers are the cheapest
mitigation available and chalk was serving none.

Decisions:

- **Everything is same-origin, so pin everything.** Scripts, styles, fonts and
  connections are pinned to the server itself — chalk bundles its fonts (34-1)
  and ships no CDN dependency, so a strict policy costs nothing.
- **One deliberate exception: Giphy.** A GIF loads from Giphy's own servers, for
  the people who opted Giphy in and nobody else.
- **`frame-ancestors 'none'`** — chalk cannot be embedded by another site.
- **Referrer policy** — chalk stops handing your address to sites you click
  through to, which matters most for URLs carrying a one-time token (an invite,
  an admin claim).

## What landed

- **51-1** — CSP and the security header set on every served page, including the
  SPA shell and the auth screens.

## Where it lives

`internal/server/server.go` (the header middleware),
`internal/server/spa_test.go` for the served-page assertions.

## Notes

The CSP has to be kept in step with the bundle: 52-2's lazily-loaded, self-hosted
MediaPipe chunk exists in that shape *because* the policy forbids fetching it
from a CDN.

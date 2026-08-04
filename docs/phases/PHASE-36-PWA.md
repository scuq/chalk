# Phase 36 — branding and the installable app

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.20 – v0.3.26.
**Tag:** `#pwa` → `tools/where.sh -g pwa`

## Why

chalk had no identity in the browser: no logo, a default favicon, and no way to
run it as its own window. The pop-out button that existed instead opened a popup
that could not reliably tell it *was* a popup, so it kept rendering its own
pop-out button inside itself.

The decision was to make chalk a **PWA** rather than keep improving the popup —
an installed app gets a real window, an icon, and a badge target (used later by
50-7's unread count), all from the platform.

## What landed

- **36-1** — chalk logo in the header; hashed favicon emitted into the bundle,
  so the icon participates in the same immutable-caching scheme as the JS/CSS.
- **36-2** — reliable pop-out detection (a popped-out window recognises itself
  and hides its own pop-out button), PWA manifest and app icons.

## Where it lives

`web/build.mjs` (icon hashing), `web/manifest.json`, `web/icons/`,
`web/src/components/App.tsx` header.

## Notes

The pop-out button was retired outright in 49-3, superseded by PWA install —
which is what this phase made possible.

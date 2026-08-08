# Phase 36 — branding and the installable app

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.20 – v0.3.26; reopened for 36-3 (unreleased).
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
- **36-3** — window controls overlay: the installed app draws `.chalk-header`
  into the title bar strip instead of sitting below the browser's, reclaiming
  the old header's height. Manifest `display_override` plus one CSS block.

### 36-3 design notes

CSS-only, deliberately. `@media (display-mode: window-controls-overlay)` goes
false the instant the user turns the overlay off from the app menu, so the
fallback to `display: standalone` needs no script;
`navigator.windowControlsOverlay` and its `geometrychange` event are only worth
reaching for when JS needs the geometry, and the layout does not.

Two things forced the shape of it:

- **The header leaves the shell's box.** `env(titlebar-area-*)` is measured
  from the window edge, but `.chalk-app` is a padded, `margin: 0 auto` box —
  capped at 1100px unless the layout-width pref (93-1) lifts the cap. In centred
  mode on a wide monitor the column starts well right of the macOS traffic
  lights, so applying the inset would indent the logo for nothing; on a window
  narrower than the column it collides with them. No padding expression is right
  in every case while the header stays in that box, so in overlay mode it goes
  `position: fixed` across the window and `.chalk-app` takes a compensating
  `padding-top`. That is equally correct in full-window mode, where there is
  simply less to correct. Content below keeps whatever width the pref gives it.
- **Drag regions are load-bearing.** `app-region: drag` on the strip, `no-drag`
  on `.chalk-header button, .chalk-header a`. Miss either half and the window
  cannot be moved, or the presence pill cannot be clicked — and neither failure
  is visible in a screenshot. Matched on elements rather than classes so a new
  header button is covered the day it lands.

The block is last in `theme.css` because it must win over the mobile block, and
carries a `min-width: 768px` guard so that block still wins where it should.

Not covered by tests: there is no DOM or render harness (`web/test.mjs` is
pure-logic only), so this is verified by eye in an installed window. Note that an
already-installed PWA does not pick up a `display_override` change on reload —
it needs reinstalling.

## Where it lives

`web/build.mjs` (icon hashing), `web/manifest.json`, `web/icons/`,
`web/src/components/App.tsx` header, `web/src/theme.css` (36-3 overlay block).

## Notes

The pop-out button was retired outright in 49-3, superseded by PWA install —
which is what this phase made possible.

# Phase 67 — link labels

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.5.5.
**Tag:** `#linkpreview` → `tools/where.sh -g linkpreview`

## Why

A modern share URL is mostly tracking parameters. Rendered raw (41-4) it fills
several lines with gibberish and pushes the actual conversation off screen.

The rule chosen: **shorten the display, never the destination.** The label shows
the host and the start of the path; the anchor still carries the full URL, so
hovering shows it, middle-click opens it, and right-click → "copy link address"
copies the real thing. Nothing is rewritten in what you typed, and nothing is
resolved through a shortener — there is no third party involved at any point.

Showing the host alone (67-1) turned out to be too little: every link from one
site looked identical. 67-3 added the start of the path back.

## What landed

- **67-1** — long URLs render as `[link to host]` labels, with a preference to
  disable and keep raw URLs.
- **67-2** — Twitch and Amazon storefronts (amazon.at / .de / .com) join the
  default link-preview whitelist.
- **67-3** — labels show host + start of path, not host alone.

## Where it lives

`web/src/chat/links.ts`, `web/src/components/MessageList.tsx`,
`web/src/components/ProfilePanel.tsx` (the preference),
`internal/config` for the preview whitelist default.

## Notes

Separate from **link previews** (phase 57), which fetch and embed a card. 67 is
purely a rendering decision on the receiving side and fetches nothing.

# Phase 34 — presence correctness and per-device text prefs

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.20 – v0.3.26. Presence semantics later relaxed by 45
(away detection), 47-7 and 60-1.
**Tag:** `#presence` → `tools/where.sh -g presence`

## Why

Presence was wrong in ways users noticed: closing a second tab took you offline,
a closing tab could delete a presence row a *newer* connection had just claimed,
and after one chalkd instance reclaimed another's dead connections nothing
re-asserted presence for the sockets still open. The root cause was that
presence counted **devices** when what is actually live is **connections**.

## What landed

- **34-1** — count connections, not devices; debounce hide → away so flipping
  tabs does not make the dot flicker for everyone. Landed alongside per-device
  font family and text-size preferences with Hack bundled as WOFF2 (no font CDN
  fetch, ever).
- **34-2** — stop clearing a live device's presence row on another connection's
  teardown.
- **34-3** — rebuild presence after an instance reclaim.

## Where it lives

`internal/presence/`, `internal/server/server.go`.

## Notes

The "away" *policy* (how long until you count as away) is not phase 34 — it is
phase 45's activity/focus detection, relaxed by 47-7 and again by 60-1. Phase 34
is only about the presence row being an honest record of live connections.

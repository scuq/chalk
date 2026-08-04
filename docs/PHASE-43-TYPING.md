# Phase 43 — typing indicators

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.45.
**Tag:** `#typing` → `tools/where.sh -g typing`

## Why

"alice is typing…" is a keystroke-rate side channel if you build it naively, and
a nuisance if it is not opt-out. Both were designed for:

- **Throttled and ephemeral.** The client sends a typing frame at a throttled
  rate, never per keystroke; the server keeps it in memory only and never writes
  it. A name disappears a few seconds after the person stops, or the instant
  their message lands.
- **Reciprocal opt-out.** Turning "show who is typing" off in the profile works
  *both ways* — you stop seeing it, and nobody sees it about you. A one-way opt
  out (see others, hide yourself) would be a free-rider setting, so it does not
  exist.
- Naming caps at five; past that the line gives up and says the keyboards are on
  fire, rather than rendering a wall of names.

## What landed

- **43-1 … 43-8** — typing frames and handlers, client throttle, the indicator
  line above the composer with its own row height (it used to clip the tops and
  tails of letters), the five-name cap, and the reciprocal profile setting.

## Where it lives

`internal/server/server.go` (typing fan-out), `web/src/components/Composer.tsx`,
`web/src/components/App.tsx`, `web/src/state/types.ts`,
`web/src/components/ProfilePanel.tsx` for the opt-out.

## Notes

Threads deliberately do not have typing indicators.

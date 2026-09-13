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
- **43-9** (unreleased) — on desktop, the line's text now starts at the same x
  position as a sender's name in a message row, and the line keeps a small gap
  above the composer.

### 43-9 design notes

Before this slice, the line started at the message pane's left edge, left of
the timestamp column, and sat directly against the composer below it.

The fix is a `::before` spacer on `.chalk-typing`, as wide as the row's left
padding plus the message gutter, the time column, and the column gap. `ch`
resolves against the element's own font, and the typing line runs at
size-small, so `padding-left` with the same variables falls short: at
size-small, the same `ch` values resolve narrower than they do in a
size-base message row, so the padding does not reach the target width. The
spacer sets its own font-size to base, so its `ch` unit matches the message
row's.

The rule is desktop only. A phone row carries no left padding and an
auto-width time column, so the typing line already starts at the timestamp's
edge there.

`margin-bottom: var(--chalk-s2)` on `.chalk-typing` adds the row's missing
gap above the composer. `.chalk-thread-panel-footer`'s padding-top calc
carries the same term, so the channel composer and the thread composer stay
level with each other.

## Where it lives

`internal/server/server.go` (typing fan-out), `web/src/components/Composer.tsx`,
`web/src/components/App.tsx`, `web/src/state/types.ts`,
`web/src/components/ProfilePanel.tsx` for the opt-out,
`web/src/components/TypingLine.tsx` for the line itself, and
`web/src/theme.css` for its layout.

## Notes

Threads deliberately do not have typing indicators.

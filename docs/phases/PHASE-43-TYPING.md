# Phase 43 — typing indicators

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.45. 43-9 and 43-10 shipped in v0.8.24.
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
- **43-9** (v0.8.24) — on desktop, the line's text now starts at the same x
  position as a sender's name in a message row, and the line keeps a small gap
  above the composer.
- **43-10** (v0.8.24) — the word "typing..." at the end of the line ripples
  letter by letter for as long as it shows, behind its own preference,
  independent of flair.

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

### 43-10 design notes

Phase 115's flair already animates a name: it cuts the name into letters and
moves them (`WaveName`, `wave.ts`). The typing word's ripple reuses that cut,
`splitLetters`, but keeps its own animation.

The typing store sweeps expired typists once a second, and that re-renders
the typing line. A letter's key must stay stable across that re-render.
Otherwise the browser reads each render as a new element, and the animation
restarts from its first frame. The word itself never changes, so each letter
keeps the same index-based key on every render.

The ripple has its own preference, `typingWave`, and does not read flair's
wave setting. A user can turn flair off and leave the ripple on, or the
reverse. The setting sits in the profile under "show who is typing." The
ripple's checkbox is disabled when that one is off, since nothing is left to
animate.

Flair's own wave rule fires only while `data-flair-wave` is set on the page,
and it sets the whole animation with the shorthand property. The shorthand
resets `animation-delay` to its default, so a shared class loses its
per-letter delays whenever flair is also on. For that reason the typing
ripple keeps its own classes, `chalk-typing-wave` and `chalk-typing-wave-ch`,
instead of flair's. Its four animation properties stay longhand — name,
duration, timing function, and iteration count — so the per-letter
`animation-delay` rules that follow are never reset.

The keyframe moves during the first third of its 1.8-second cycle, then
holds still for the rest of it. That reads as a ripple that passes and
pauses, not a constant wobble. Nine `nth-child` rules, one per letter of
"typing...", stagger the ripple 70ms apart. A `prefers-reduced-motion` query
turns the animation off and leaves the letters in place.

Rejected: reusing `WaveName`'s classes or flair's classes directly. Flair's
shorthand rule resets the per-letter delays whenever flair is also on, so a
shared class breaks under that combination.

Rejected: a wave on the sender names or on the whole line, instead of the
word alone. The names already carry tint, and flair can wave them too. A
second wave on the same name layers two animations on one piece of text. A
wave on the whole line moves the sender names and the punctuation along with
the word. That reads as noisier than a wave on the word alone.

Rejected: a ripple that is always on, with no switch to turn it off. The
base typing indicator already has its own settings row (43-8), and the
ripple follows the same opt-out principle.

## Where it lives

`internal/server/server.go` (typing fan-out), `web/src/components/Composer.tsx`,
`web/src/components/App.tsx`, `web/src/state/types.ts`,
`web/src/components/ProfilePanel.tsx` for the opt-out,
`web/src/components/TypingLine.tsx` for the line itself,
`web/src/chat/wave.ts` for the per-letter cut, and
`web/src/theme.css` for its layout.

## Notes

Threads deliberately do not have typing indicators.

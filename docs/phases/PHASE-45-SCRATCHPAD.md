# Phase 45 — the voice scratchpad, away detection, and honest unread dots

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.46 (45-1…45-2), v0.4.3 (45-3…45-4), 45-6 later; 45-7 added 2026-08-29; 45-8 added 2026-09-05.
**Tags:** `#voice`, `#unread`, `#threads` → `tools/where.sh -g voice`

## Why

**The scratchpad.** Text in a voice channel is for the call and nothing else —
a link, a line someone is talking over, a GIF. Treating it as durable chat
history would mean a voice room slowly accumulating a transcript nobody agreed
to. So it is deliberately lossy: only as much as fits between the call and the
composer is shown, older lines slide off and are gone, and the whole thing is
deleted for everyone and off the server the moment the last person leaves. The
rule is written under the call so nobody has to discover it the hard way.

**Away detection.** Presence was watching the wrong thing: it looked only at
whether the tab was visible, so chalk open beside the app you were working in
showed you online indefinitely, and walking away from a locked screen did too.
Phase 45 watches interaction and focus as well, and — on Chromium only, behind a
one-time permission — the system idle signal. Firefox and Safari do not offer
it, so the switch is not shown there rather than being shown broken. Nothing
about it is sent anywhere; it is a per-device setting.

**Unread dots that mean something.** A voice channel's scratchpad is destroyed
when the call ends, so an unread dot pointing at it from outside the room points
at nothing. Dots on voice channels are now gated on room presence, and emptying
a room marks it read for everybody — a dot could otherwise come back on the next
reconnect and refuse to clear.

## What landed

- **45-1 … 45-2** — the voice scratchpad (rotating view, purge on empty room)
  and the video / screen pop-out.
- **45-3** — voice scratchpad dots gated on room presence; threads dot recounted
  on read; mark-all-read on the threads list (respecting the active filter).
- **45-4** — the threads dot counted live from held rows and corrected against
  the server's total.
- **45-5** — away detection following activity and focus, with optional
  system-wide idle on Chromium.
- **45-6** — the system-idle threshold raised off the API's 60s floor to 10
  minutes.
- **45-7** (2026-08-29) — known system activity now beats the hidden-tab
  grace, not only the two focus timeouts. The desktop shell made the old
  order visible: close-to-tray and a minimized window both read as hidden,
  so a PC in the middle of a game went away after six minutes while the
  shell was reporting input every tick — and with the notebook away too,
  the max-precedence aggregate followed. `decideIdle` rules 3 and 4 swapped;
  where `systemIdle` is undefined (Firefox, Safari, the toggle off) the
  hidden rule is unchanged. Tests in `idle.test.ts` pin all three cases.
- **45-8** (2026-09-05) — the scratchpad stopped bidding for the call's
  height. Reported from a four-person call: the bottom row of tiles cut in
  half, the control bar drawn across a face. Two separate faults, both in
  `theme.css` — see *The height split* below.

## The height split (45-8)

The voice pane is a flex column that clips rather than scrolls, and the
declared priority (45-3) is that the call holds the top, the scratchpad takes
what is left, and what gives up height when the pane runs short is the video,
never the controls under it. Neither half of that was true.

**The feed was bidding.** `.chalk-messages--ephemeral` was `flex: 1 1 auto`,
and `auto` means "my flex base size is my content height". A call's scratchpad
holds up to sixty rows (`EPHEMERAL_MAX_ROWS`), so the feed walked into the
sizing with a base of ~1500px against the call panel's ~545px. Both are
shrinkable, so flex split the deficit between them in proportion to those
bases — and the call, which is the one thing in the pane that cannot afford to
lose height, gave up two thirds of it. Measured in a real browser at 1440×1000
with four tiles: an empty scratchpad left the panel at 545px, twenty rows took
it to 398px, sixty rows to 208px. `flex: 1 1 0` is the fix; the feed now asks
for nothing and takes only leftovers, which costs it nothing, because
everything above the fold is clipped and unreachable anyway.

**The stage was spilling.** Squeezing `.chalk-voice-stage` moves the control
bar up, but the grid inside it does not follow: `.chalk-voice-peer--grid` takes
its height from its width through `aspect-ratio`, so the rows keep their size
and overflow the stage box. The bar and the scratchpad rule are laid out after
the stage, so they landed on top of the last row of faces. `overflow: hidden`
on the stage makes the overflow crop instead — the documented trade, video
before controls.

Rejected: making the tiles shrink with the stage. `%` heights need a definite
container height and the stage has none, so it would take either a viewport
`calc()` against a hand-measured constant for everything else in the pane
(~390px, and wrong the moment the font scale moves) or a ResizeObserver
feeding a custom property. Both were more machinery than the bug warranted.

**Still open.** Below roughly 850px of window height a four-tile call does not
fit even with an empty scratchpad, and the bottom of the grid is now cropped:
43px at 1440×800, 88px at 1440×700. Nothing overlaps and no control is lost,
but the picture is cut. The fix if it becomes worth doing is to scale the grid
down instead of cropping it — cap `.chalk-voice-grid`'s `max-width` from the
height the pane can spare, which keeps the tiles at 16:9 and all four whole;
a probe run of that variant gave 360×203 tiles at 800px and 272×153 at 700px
with no crop. It needs the constant above, hence the deferral.

**How it was measured.** jsdom has no layout, so `web/test.mjs` cannot see any
of this; the numbers came from a Playwright probe that renders the real
`theme.css` around a synthetic voice pane and reads back the boxes. What the
suite *can* hold is the two declarations themselves, which is
`theme-voice-pane.test.ts`.

## Where it lives

`internal/proto/voice.go`, `internal/server/server.go` (purge),
`web/src/state/reducer.ts` (and `reducer-voice-purge.test.ts`),
`web/src/chat/threadinbox.ts`, `web/src/notify/gate.ts`,
`web/src/components/VoiceCallPanel.tsx`, `web/src/presence/`.
The pane's height rules are `.chalk-main--voice` and
`.chalk-messages--ephemeral` in `web/src/theme.css`, held by
`web/src/theme-voice-pane.test.ts`.

## Notes

The away *thresholds* were relaxed three times afterwards — 47-7 (all three
in-page windows), 60-1 (unfocused 5 → 10 minutes) and 45-6 (system idle 1 → 10
minutes) — because reading a long thread or sitting in a call should not read as
away.

45-6 is the one that had been hiding in plain sight: the in-page windows were
tuned repeatedly while `IdleDetector` ran at 60s, the API's *floor*, mistaken in
a comment for a fixed value. Anyone on Chromium who granted the permission — the
setting is on by default, so that is the intended configuration — got the
one-minute rule regardless of everything 47-7 and 60-1 had relaxed, because a
true `systemIdle` outranks all three windows. Damping this signal means raising
that threshold, never adding a second timeout on top of it in `decideIdle`:
`systemIdle === false` is load-bearing there, since it is what suppresses the
in-page windows for someone who is at their machine but not touching chalk.

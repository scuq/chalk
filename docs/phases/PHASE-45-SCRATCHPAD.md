# Phase 45 — the voice scratchpad, away detection, and honest unread dots

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.46 (45-1…45-2), v0.4.3 (45-3…45-4), 45-6 unreleased.
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

## Where it lives

`internal/proto/voice.go`, `internal/server/server.go` (purge),
`web/src/state/reducer.ts` (and `reducer-voice-purge.test.ts`),
`web/src/chat/threadinbox.ts`, `web/src/notify/gate.ts`,
`web/src/components/VoiceCallPanel.tsx`, `web/src/presence/`.

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

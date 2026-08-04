# Phase 63 — the equal-tile grid, the speaking dot, and mic resolution by label

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.5.1.
**Tag:** `#voice` → `tools/where.sh -g voice`

## Why

Three call-usability gaps:

- **Group calls looked like a broadcast.** The big-tile + filmstrip stage from
  30-5 is right for two people and wrong for five: one person large, everyone
  else a thumbnail. Three or more now get an equal-tile grid, rows growing down,
  with the scratchpad yielding height past four participants. Clicking a tile
  still returns to the focused view, and a screen share still takes the
  spotlight.
- **You could not see who was talking.** The speaking dot is computed from
  **passive sync-source levels** already present in the RTP stats — no extra
  audio analysis per peer, no decoding work added to a call that is already
  paying for a mesh.
- **The chosen microphone silently stopped applying.** Device *ids* are not
  stable: Brave re-randomizes them per session, and a headset not yet connected
  at join time never matches. Calls fell back to the built-in mic with no
  indication — most visible on macOS with AirPods. The fix is to persist the
  device **label** and re-resolve at capture time, follow `devicechange` so
  connecting the headset mid-call switches to it, and **say so** when the device
  is genuinely absent rather than switching silently.

## What landed

- **63-1** — equal-tile grid for group calls: dummy-tile fill, rows grow down,
  scratchpad yields past four.
- **63-2** — green speaking dot on call tiles via passive sync-source levels.
- **63-3** — mic choice resolves by label and follows `devicechange`.

## Where it lives

`web/src/voice/grid.ts`, `web/src/voice/speaking.ts`,
`web/src/voice/device-resolve.ts`, `web/src/voice/mic-prefs.ts`,
`web/src/voice/mic-chain.ts`, `web/src/components/VoiceCallPanel.tsx` —
each with a `.test.ts` beside it.

## Open item

The **camera** picker still resolves by id and has the exact weakness 63-3 fixed
for the mic. Same fix applies: persist the label, resolve via
`voice/device-resolve.ts` at capture time. Listed in CLAUDE.md under deferred
cleanup.

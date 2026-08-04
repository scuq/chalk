# Phase 66 — call preferences that follow the account

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.5.4.
**Tag:** `#voice` → `tools/where.sh -g voice`

## Why

Three problems, one theme: what you decided about a call should survive the
browser you decided it in.

- **A new device joined live.** A machine that had never used voice joined the
  first room with an open microphone. Phase 44 made mute sticky *per device*,
  which does nothing for a private window, a cleared profile or a new laptop. So
  "start muted on a new device" is an **account** setting; on a machine already
  used, the mute button stays in charge, as before.
- **Camera off still opened the camera.** Nothing was sent, but the browser's
  camera indicator lit for the whole call — indistinguishable from actually
  being on film. With the camera off the device is now not opened at all, and
  switching it on mid-call asks for permission at that moment.
- **Per-peer mute and volume lived on one browser.** Silencing someone on the
  laptop did nothing on the desktop. These now sync — and because "who I have
  silenced" is exactly the kind of social metadata chalk refuses to hand over,
  the list is **sealed client-side** before it is stored, like phase 50's
  notification rules. A change reaches a call already running elsewhere.

## What landed

- **66-1 / 66-2** — account-wide start-muted default; camera off no longer opens
  the device.
- **66-3** — per-peer mute/volume list synced across devices, sealed
  client-side.
- **66-4 / 66-5** — legible on-video tile controls (larger, always light against
  the tile's black strip whatever the theme, a volume slider worth aiming at,
  "mute" instead of "mute for me" on strip tiles); optional per-peer latency
  overlay, amber past 150 ms, red past 300 ms, off by default — previously
  reachable only through the debug drawer.

## Where it lives

`web/src/voice/peer-audio-store.ts`, `web/src/voice/peer-audio-sync.test.ts`,
`web/src/voice/join-muted.test.ts`, `web/src/voice/call.ts`,
`web/src/voice/session.ts`, `web/src/components/VoiceCallPanel.tsx`,
`web/src/components/MicSettings.tsx`.

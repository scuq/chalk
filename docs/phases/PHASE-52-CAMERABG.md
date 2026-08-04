# Phase 52 — camera background effects

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.4.4.
**Tag:** `#camera-bg` → `tools/where.sh -g camera-bg`

## Why

Background blur is a privacy feature, so doing it the usual way — ship the frame
somewhere to be segmented — would invert the point. Everything happens on the
device, before encryption, and nothing about the picture leaves the machine.

Three decisions shaped the implementation:

- **Use the platform when it can.** Where the camera or OS blurs natively
  (`backgroundBlur` in MediaStreamTrack constraints), chalk lets it: zero cost,
  better result. The in-browser path is the fallback, not the default.
- **Self-host MediaPipe, lazily.** The CSP (51-1) forbids a CDN, so the
  segmentation chunk ships with chalk and is loaded only when blur is first
  switched on — roughly 3.7 MB once, then cached.
- **Degrade loudly, never quietly.** On a machine that cannot keep up, blur
  reduces its segmentation cadence first (the edge lags a little) rather than
  letting the outgoing video turn choppy for everyone watching. If it still
  cannot keep up it switches itself **off and says so** — the same if it cannot
  start at all. The user is always told when their camera is unblurred rather
  than left to guess.

It hangs off 44-10's canvas publishing graph, which is why it can be toggled
mid-call without the picture dropping for viewers.

## What landed

- **52-1** — camera effects seam, background-blur preference, native platform
  blur path.
- **52-2** — background blur in the browser: MediaPipe segmentation,
  lazy-loaded and self-hosted.
- **52-3** — keep blur inside the frame budget: adaptive segmentation cadence,
  give up loudly.
- **52-4** — preview your camera in settings, blur and all, without being in a
  call.

## Where it lives

`web/src/voice/camera-effects.ts`, `camera-blur.ts`, `camera-chain.ts`,
`camera-budget.test.ts`, `web/src/voice/device-prefs.ts`,
`web/src/components/MicSettings.tsx`, `web/build.mjs` (the lazy chunk),
`internal/server/spa_test.go`.

## Open item

`docker/Dockerfile`'s frontend stage runs `npm run build` without
`NODE_ENV=production`, so released images ship the MediaPipe chunk unminified —
153 KB minified vs 737 KB as shipped. Listed in CLAUDE.md under deferred
cleanup; this phase is what made it expensive.

# Phase 30 — voice and video

*Backfilled record.* Written after the fact from the commit history, the
changelog and the design spec. The full contemporaneous design lives in
[design/chalk-phase-30-voice-video-design.md](design/chalk-phase-30-voice-video-design.md)
including Addenda A (audio), B (screen/game share), C (parity scorecard) and
D (bandwidth probe + downscaler) — this file is the slice index and the
as-built summary.

**Status:** shipped, pre-v0.1.0 through v0.2.x. Extended by 41, 44, 45, 47, 48,
63, 66, 70, 71.
**Tag:** `#voice` → `tools/where.sh -g voice`

## Why

chalk needed Discord-style voice channels without giving the server anything it
does not already have. Two constraints drove every decision:

- The server is a blind relay for text; it must stay one for voice. Signaling is
  encrypted under the channel space key, so the server routes opaque blobs.
- A key-substituting server must not be able to MITM a call. DTLS fingerprints
  are Ed25519-signed by the sender's identity key; a bad signature aborts the
  peer connection rather than degrading to an unauthenticated one.

Full mesh, not an SFU: for the room sizes chalk targets a mesh is simpler,
needs no media server, and keeps the server out of the media path entirely.
coturn is mandatory as a relay, never as a decryptor.

## What landed

- **30-1** — schema 0038 (`channel_type`, `voice_participants`), room store
  (join/leave/roster/state/conn-cleanup/janitor), TURN REST credential minter,
  `CHALK_VOICE_*` / `CHALK_TURN_*` config, voice channel creation.
  30-1a/30-1b patched `ChannelType` through create input and payload.
- **30-2** — signaling relay: voice frames and handlers, join-ack carrying the
  roster plus minted ICE servers, opaque peer-routed `voice_signal`, roster-delta
  fan-out via pubsub, instance-scoped disconnect cleanup and orphan janitor.
- **30-3** — coturn deployment: dev targets, prod compose service (host
  networking, TURN REST secret), voice env, deployment docs (firewall, sizing,
  `turns:` hardening, secret rotation).
- **30-4** — client WebRTC mesh and anti-MITM: E2E signaling, fingerprint
  binding (design Slice F), relay-only mode, minimal uplink budget.
  **30-4d** spooled voice signal payloads — NOTIFY's 8000-byte cap broke camera
  offers, so payloads move to a fetch-on-notify consumer with a janitor sweep.
- **30-5 … 30-5j** — Discord-style room UI: sidebar occupancy with media badges
  and SVG channel-type glyphs, big-tile + filmstrip stage, click-to-join,
  persistent session and dock with micro-PiP, per-participant local audio
  (mute / volume), call duration, diagnostics drawer (event ring, getStats,
  copy report).
- **30-6** — polish: removed-member eviction cascade, WS-loss teardown,
  post-join state sync, getUserMedia error UX, `voice_enabled` welcome flag.
- **30-7a/b** — screen and game share: perfect negotiation, separate screen
  transceivers (camera + screen simultaneous), motion/detail/text Prioritize
  toggle (contentHint + mode-keyed degradationPreference), mode-dependent codec
  ladder via `setCodecPreferences` (AV1 CPU-gated), shared program audio,
  per-viewer screen hide, mid-call camera add.
- **30-8** — adaptive quality (Addendum D): pre-stream uplink probe
  (`POST /api/netprobe`) picks the starting tier; passive getStats re-checks on
  `CHALK_VOICE_RECHECK_SECS` — never an active mid-call test; a mesh budget
  divider (headroom → per-peer audio reserve → per-copy caps, screen prioritized
  over camera thumbnails) feeds a per-mode tier ladder with hysteresis (fast
  down, slow single-rung up), applied via `sender.setParameters` without
  renegotiation. Game's bottom rung pauses and warns.
- **30-9** — transport knobs in the debug drawer; the IPv4-only filter becomes
  opt-in rather than always-on.
- **30-10** — coturn configured via unit Exec args with detected public IP and
  a TCP TURN URL, so networks blocking UDP can still connect.
- **30-11** — auto-join a voice room once per selection, not on every
  channel-list refresh.

## Where it lives

`internal/turncred/`, `internal/store/voice.go`, `internal/server/voice_ws.go`,
`internal/server/voice_event.go`, `internal/proto/voice.go`,
`web/src/voice/`, `web/src/components/VoiceCallPanel.tsx`,
`web/src/components/VoiceDock.tsx`.

## Open items

- The **SFU seam** (design Slice I) for rooms too large for a mesh is designed
  and not built. It stays the named next step for voice.
- Rejoin after a WS drop was a manual click in 30-6; 62-9 made it automatic.

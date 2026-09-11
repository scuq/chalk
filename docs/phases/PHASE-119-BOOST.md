# Phase 119 — boost: a participant turned up past 100%

**Status:** built, 119-1 (2026-09-12). Unit-tested (`web/src/voice/boost.test.ts`
pins the ceiling and the element/gain split; `peer-audio-sync.test.ts` the
store's new range). Not yet heard in a real call — the checklist below.
**Tags:** `#voice` → `tools/where.sh -g voice`

## The problem

scuq asked whether a person's volume could go above 100%. It could not: the
per-peer sliders (A4 subset, 30-5; the share's own pair since 96-3) drove
`HTMLMediaElement.volume`, which stops at 1.0. So a loud person could be
turned down but a quiet one never up, and "I can't hear you" had no answer
on the listening side.

## The design

### 119-1 — a gain graph above 1, nothing below it

- **The ceiling is 200%** (`MAX_PEER_VOLUME` in `web/src/voice/boost.ts`).
  Discord stops there too; past double, a gain is mostly clipping, and a
  person who needs more has a microphone problem this cannot fix.
- **Under the ceiling nothing changes.** `elementVolume()` is the level as
  before and no Web Audio runs. The path that has always shipped is the
  path the common case still takes.
- **Over 1 the element cannot carry the level**, so the dock's `AudioSink`
  (`VoiceDock.tsx`) routes the peer's stream through `openBoost()`:
  `MediaStreamSource → GainNode → MediaStreamAudioDestinationNode`, and the
  `<audio>` element plays the destination's stream at 1. The element keeps
  every job it had — local mute, deafen, `setSinkId` to the chosen output —
  because the graph replaces what it is fed, not how it is played. Dropping
  back to 100% or under tears the graph down and the raw stream returns.
- **One shared `AudioContext`** for all boosted playback, created on first
  use. A slider drag is a gesture, so it is running when the first boost is
  asked for. A **reload with a stored boost** has had no gesture: a context
  born suspended would play silence for that peer, so the sink only routes
  through the graph while `isBoostRunning()`, plays the raw stream at 100%
  until then, and the next pointer or key anywhere resumes it
  (`hookBoostResume`, the same one-shot the dock uses for autoplay-blocked
  elements).
- **Chromium quirk:** a remote WebRTC track only feeds Web Audio while some
  media element is also playing it, so the raw stream stays attached to a
  second, muted `<audio>` for as long as the graph is in use.
- **Store and sync:** `clampPeerVolume` (0..2, junk → 1) is the one
  normaliser, used by `peer-audio-store.ts` and `session.ts`. A device still
  on the old build reads a boosted row as 1, which is the right fallback,
  and writes it back as 1 on its next edit — whole-blob last-write-wins,
  as 66-3 documents.
- **The slider** (`VoiceCallPanel.tsx`, both `voice-peer-volume` and
  `voice-screen-volume`) runs 0..200 in steps of 5, and past 100 takes
  `chalk-voice-volume--boost`, which paints the thumb in the alert colour
  the local-mute button lights up in.

**Rejected:** a separate "boost" toggle beside the slider. One control that
runs further is simpler than two, and the coloured thumb says which half of
the range you are in. **Rejected:** `AudioContext.setSinkId` in place of the
element's — newer, Chromium-only, and it would move output-device routing
onto a second mechanism for the boosted peers alone.

## Manual checklist

- [ ] In a call, pin a peer, drag past 100%: they get louder; back to 100%
      or under sounds exactly as before.
- [ ] Deafen and local mute still silence a boosted peer; output-device
      choice still applies to them.
- [ ] Reload with a boost stored: the peer is audible at once (at 100%),
      and the first click anywhere brings the boost in.
- [ ] Firefox and Safari: the boost works (Web Audio is universal) — or at
      worst the peer plays at 100%.
- [ ] A shared screen's sound boosted while the sharer's voice stays put.

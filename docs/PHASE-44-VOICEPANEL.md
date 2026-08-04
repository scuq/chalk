# Phase 44 — the global voice panel, composer tools, and device pickers

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.45 (44-1…44-7), v0.4.2 (44-8…44-10).
**Tag:** `#voice` → `tools/where.sh -g voice`

## Why

Voice controls only existed *inside* a call, which is exactly the wrong time to
find them: you joined live and scrambled for the mute button. The reframing in
this phase is that mute / deafen / camera are **account state, not call state** —
whatever the panel shows is how you join the next room. They persist across
leaving a room, dropped connections and reloads.

Two other things moved for the same reason: the attach / GIF / emoji buttons sat
a screen's width from the field they act on, and microphone settings sat three
quarters of the way down the profile panel rather than next to the mute button —
where you already are when nobody can hear you.

Mic settings follow the **account**, except the chosen input device, which names
a socket on one machine and stays per device. (63-3 later revisited that: the
device *id* is not stable either, so it is resolved by label.)

## What landed

- **44-1 … 44-4** — composer tool block beside the field (icons by default,
  words still available as a setting); the global voice panel under the channel
  list; the mic settings dialog behind the ⚙, synced through the profile.
- **44-5 … 44-7** — panel polish and profile pointer.
- **44-8** — VAD thresholds become draggable marks on a **dB** level meter, so a
  normal speaking voice sits mid-bar instead of squashed into the first
  centimetre; AGC defaults **off**, because it filled the pauses between
  sentences by winding the mic up and kept moving the floor the marks are set
  against. Sliders track live instead of committing on release, and the "too
  loud" warning sits at a level real signals actually reach.
- **44-9** — camera and output device selection, with a live mid-call camera
  swap. Pickers appear only when there is more than one of that kind; output
  selection is hidden entirely on browsers without `setSinkId` rather than
  pretending.
- **44-10** — publish the camera through a **canvas graph**, which is what makes
  the device swap free (no renegotiation, no black frame) — and the seam phase
  52 later hangs background blur on.

## Where it lives

`web/src/voice/mic-prefs.ts`, `web/src/voice/call.ts`,
`web/src/voice/session.ts`, `web/src/components/VoiceControls.tsx`,
`web/src/components/VoiceDock.tsx`, `web/src/components/MicSettings.tsx`,
`web/src/components/Composer.tsx`.

## Open item

The camera choice (`device-prefs.ts` `cameraId`) still has the stale-id weakness
the mic had before 63-3: Brave re-randomizes deviceIds per session and
late-plugged devices go unmatched. Fix the same way — persist the label, resolve
via `voice/device-resolve.ts` at capture time. Listed in CLAUDE.md under
deferred cleanup.

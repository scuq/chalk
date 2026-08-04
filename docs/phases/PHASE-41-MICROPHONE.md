# Phase 41 — microphone settings, transmit modes, and the row menu

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.41 / v0.3.42. Mic work extended by 44 (dialog, account
sync), 44-8 (dB meter), 63-3 (label-based device resolution).
**Tags:** `#voice`, and the row menu under `#mobile` / message actions →
`tools/where.sh -g voice`

## Why

Voice shipped in phase 30 with whatever microphone the browser picked and no
control over when it transmitted. That is fine for a two-person call and
unusable in a room: no device choice, no gain, no push-to-talk, and no way to
tell whether you were being heard.

The design decision that matters: chalk builds its **own capture graph** (a
WebAudio chain) rather than handing `getUserMedia` constraints to the browser
and hoping. That is what makes input gain, a live level meter, VAD thresholds
and mid-call device swaps possible at all — and it is the same graph 44-10 later
reuses for the camera.

Keys are honest about their limit: a web page cannot claim a key from the rest
of the system, so push-to-talk only works while a chalk tab is in front. The UI
says so rather than letting people discover it in a fullscreen game.

## What landed

- **41-1** — microphone input settings: capture graph, device picker, input
  gain.
- **41-2** — transmit modes: always-on, open-when-I-speak (VAD with two
  thresholds and a hold time), push-to-talk, push-to-mute; mute and deafen keys.
- **41-3** — message actions move into a pointer-anchored row menu (the old
  hover strip covered the end of long lines and was clipped by the feed's bottom
  edge); the row marker shrinks so it clears the timestamp.
- **41-4** — render `http(s)` URLs in message bodies as links.
- **41-6** — voice dock controls collapse to single letters (`m`, `d`, `l`) in a
  narrow sidebar instead of spilling over the message list.

## Where it lives

`web/src/voice/mic-chain.ts`, `web/src/voice/mic-prefs.ts`,
`web/src/components/MicSettings.tsx`, `web/src/components/VoiceDock.tsx`,
`web/src/chat/links.ts`, `web/src/chat/message-menu.ts`.

## Notes

The VAD thresholds were percentage sliders here; 44-8 turned them into draggable
marks on a dB level meter and defaulted AGC off, because automatic gain control
kept moving the floor the marks were set against.

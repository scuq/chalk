# Phase 40 — notification sounds

*Backfilled record.* Written after the fact from the commit history and the
changelog. **Superseded by phase 102:** the synthesizer this records
(`synth.ts`, `SOUND_SPECS`, `tools/sound-bench.mjs`) was removed and replaced
by recorded sound themes — see
[PHASE-102-SOUNDTHEMES.md](PHASE-102-SOUNDTHEMES.md). What follows is the
design as it shipped, kept as history. The tuning rationale — why each number in `SOUND_SPECS` is what it is
— lives in [notification-sounds.md](../notification-sounds.md) and in the source
comments, which are the authority.

**Status:** shipped, v0.3.40. Extended by 50 (rules engine) and 71 (call sounds,
chalk-stroke grain).
**Tag:** `#notify` → `tools/where.sh -g notify`

## Why

chalk needed to be able to interrupt you, and it needed to do that without
shipping sample files. Every sound is **synthesised on the device** from a
generator graph — no audio assets in the bundle, no fetch, and a coherent family
of sounds that can be re-pitched per event instead of a pile of unrelated wavs.
The palette is a stroke of chalk on a board, pitched per category so the events
are distinguishable without looking.

Three gates were designed in from the start, because a chat app that pings for
everything gets muted permanently:

- **Suppression**: no sound for the channel you are already reading.
- **Rate limit**: never more than once every couple of seconds.
- **Gesture gate**: no audio until you have clicked something, so a tab left
  open overnight stays silent.

Sound settings are per device, not per account — your phone and your desktop are
allowed to disagree about volume.

## What landed

- **40-1** — the sound engine: the chalk-stroke pack, the suppression gate,
  per-device preferences.
- **40-2** — sounds for arriving messages, mentions, DMs and thread replies.
- **40-3** — notification settings in the profile, with a preview button per
  sound.
- **40-4** — presence, connection and error sounds; the sounds doc rewritten.

## Where it lives

`web/src/notify/` — `synth.ts` (the specs), `gate.ts` (suppression),
`index.ts` (the bus). Settings in `web/src/components/ProfilePanel.tsx`.

## Notes

**Never derive the spec numbers.** `SOUND_SPECS` is the recording of a listening
session; changing a value means listening again and rewriting the comment with
it. `node tools/sound-bench.mjs` builds the bench for that session — every
category, the real synth graph extracted from source, sliders, A/B against
what's committed, and the `synth.test.ts` invariants shown live.

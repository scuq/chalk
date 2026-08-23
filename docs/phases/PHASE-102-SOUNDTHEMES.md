# Phase 102 — sound themes

**Status:** 102-1 shipped. One slice; the phase is closed unless a follow-up
under [Left open](#left-open) is taken up.

**Tag:** `#notify` → `tools/where.sh -g notify` (shared with 40, 50 and 71).

## The problem

Phases 40 and 71 built chalk's notification sounds as a *synthesizer*: pink
noise through swept bandpass filters, a random stick-slip grain modulator,
no oscillators, and seventeen hand-tuned `StrokeSpec` rows whose every number
had to be defended in a comment and re-listened to in a bench page
(`tools/sound-bench.mjs`) whenever one moved. It worked, and it was the wrong
tool: the design problem it kept solving — making friction noise sound like
warm chalk and never like a screech — is a sound-design problem, and a DAW
solves it in an afternoon with a waveform you can hear while you shape it.
The table of numbers was a recording of a listening session pretending to be
code.

scuq authored three complete themes as WAV files — *chalk* (the same grammar
the synth aimed at: scrapes, taps, dust; up for arrival, down for departure),
*gamegirl* (classic-handheld pulse-wave bleeps) and *runestone* (fantasy UI:
horns, bells, parchment, portals) — and asked for the synthesizer to be
replaced by them.

## The design

- **Recorded cues, shipped as assets.** `web/assets/sounds/<theme>/` holds ten
  WAVs (48 kHz, 16-bit, stereo, each under a second) plus the theme's own
  `MANIFEST.md`. `notify/theme-assets.ts` imports every one; esbuild's file
  loader (a `.wav` entry in `build.mjs`) emits each content-hashed into
  `dist/`, so `spa.go` serves them immutable like every other asset and a
  changed cue is a new URL. ~2 MB in the image, nothing at runtime until a
  theme is warmed.
- **Ten cues, seventeen categories.** The themes were authored for the ten
  events a listener can tell apart. The eight rules-routed event types all
  play the *new message* cue; each machine noise has a cue of its own.
  `CUE_FOR` in `themes.ts` is the single mapping, exhaustive over
  `SoundCategory` and held so by the test.
- **The player keeps the AudioContext.** `player.ts` replaces `synth.ts` but
  keeps the graph's shell: a master `GainNode` the volume slider drives, the
  44-9 `setSinkId` output routing, and the unlock-in-a-gesture model that lets
  sounds default to on without a tab startling anyone. The source is a decoded
  `AudioBuffer` per (theme, cue) instead of a noise graph. An `<audio>` element
  would have been simpler and would have lost all three. Buffers decode
  lazily and are warmed on unlock and on theme change; a cue that fails to
  fetch or decode is cached as silent, never retried per message, never thrown
  out of a frame handler. A play whose decode finishes after the theme changed
  or the context closed is dropped as stale.
- **Per-device preference.** `theme` joins `chalk.notify.v2` beside the volume
  — same key, no version bump: an old entry gets the default, an unknown id
  (downgrade, retired theme) falls back the same way. A theme is a taste, and
  the phone and the desk may differ, so it is deliberately not synced.
- **The picker.** A `<select>` in profile → notifications above the machine
  noises, with the chosen theme's one-line description. Choosing plays the
  message cue immediately — the change is the gesture that unlocks audio, and
  it is the cue you will hear most — and the existing per-noise play buttons
  preview in whatever theme is selected. `preview()` takes the theme
  explicitly, because the pref write reaches `NotifySounds` through a Preact
  state updater that may run after the click handler.
- **Tests replace the synth's invariants.** `synth.test.ts` guarded a lowpass
  ceiling and a Q cap that no longer exist. `themes.test.ts` guards what can
  now go wrong silently: every category maps to a cue, every theme folder
  holds every cue as a well-formed 48 kHz 16-bit PCM WAV under a second, no
  stray WAV sits in a folder, the default theme exists. `prefs.test.ts` pins
  the theme fallback.

### Rejected

- **Keeping the synth as a fourth theme.** It would have kept 700 lines, the
  bench, the CLAUDE.md gotcha and the `SCREECH_FLOOR_HZ` invariants alive for
  a theme the *chalk* WAVs already replace with the same grammar. Gone.
- **Distinct cues per event type** (mention vs dm vs message). The themes
  were not authored that way, and the banner and badge already carry that
  distinction. The mapping is one table row per category, so a theme that
  grows a mention cue changes the row and nothing else.
- **A directory hash like the MediaPipe runtime** (`emitMediaPipe` in
  `build.mjs`). That pattern exists because MediaPipe builds its own URLs
  from a base path; the player builds none, so per-file hashing through the
  ordinary loader is simpler and finer-grained.
- **Converting to Opus/OGG** for size. Would need ffmpeg in the build or a
  new dependency; 2 MB of WAV in an image that already carries an 11 MB
  WASM is not worth either. Left open below.
- **Syncing the theme with the rules blob.** Volume is device-local for a
  reason (headphones vs a phone in a room) and a theme is the same kind of
  thing.

## Slices

- **102-1** — the three themes as assets; `themes.ts` (table, mapping),
  `theme-assets.ts` (imports), `player.ts` (replaces `synth.ts`); `theme` in
  prefs; the picker in `ProfilePanel.tsx`; `.wav` loaders in `build.mjs` and
  `test.mjs`; `synth.ts`, `synth.test.ts`, `tools/sound-bench.mjs` and its
  template removed; docs and CLAUDE.md rewritten.

## Manual checklist

Verified by the chain (tsc, `node test.mjs`, `node build.mjs`, Go chain); not
yet heard in a browser by this change set:

- [ ] profile → notifications shows the theme picker; switching plays the
      message cue at once, in the new theme.
- [ ] each play button previews in the selected theme; volume slider still
      scales them; output-device choice (44-9) still routes them.
- [ ] a call's join/leave and a peer's join/leave play the right cues.
- [ ] the default volume (0.4) is right for the WAVs' level — the synth's
      output sat well below full scale, the recordings may not. If the
      default needs to move, it moves in `DEFAULT_SOUND_PREFS` only.
- [ ] a reload keeps the theme; an old `chalk.notify.v2` entry without one
      falls back to *chalk*.

## Left open

- **Default volume against the recordings' level** — see the checklist.
- **Compressed cues.** If image size ever matters, an Opus/OGG conversion
  step with ffmpeg in the frontend build stage; browsers decode both through
  the same `decodeAudioData`.
- **A distinct mention cue.** One new file per theme plus a `ThemeCue`; the
  `CUE_FOR` rows for `mention` and `dm` move. Same shape as phase 87's
  reminder cue.

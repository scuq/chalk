# Phase 102 — sound themes

**Status:** 102-1, 102-2 and 102-3 shipped; the phase is closed unless a
follow-up under [Left open](#left-open) is taken up.

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
  **102-3 revisits the conclusion, not the reasoning:** the synth's *sound*
  came back as a fifth theme, and none of the code did. See the slice.
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
- **102-2** — a fourth theme, *empir* (medieval RTS: horns, timber,
  blacksmith metal, war drums; the id is scuq's spelling, not the source
  folder's "empire"). New folder + `SoundThemeId` + `SOUND_THEMES` row +
  import block, exactly the "adding a theme" recipe above. The test's cue
  ceiling moved from one second to two for its join fanfare, its bit-depth
  pin widened to 16-or-24 (the two DAW re-exports are 24-bit), and duration
  is measured from the WAV's data chunk rather than the file size.
  **Rights caveat, closed at landing:** the two cues that first arrived
  derived from supplied recordings (an AoE2 "wololo", a YouTube excerpt) were
  replaced by scuq with synthesized versions before the theme ever shipped in
  a release; nothing source-derived is in the repo's history past this slice's
  landing, and the theme's MANIFEST records the replacement.
- **102-3** — a fifth theme, *chalk classic*: the deleted synthesizer's own
  output, rendered offline to ten WAVs. See below.

## 102-3 — the synth, as a theme

102-1 rejected "keep the synth as a fourth theme" because of what keeping it
would cost the client: 700 lines of filter graph, the bench page, the
`SCREECH_FLOOR_HZ` invariants and their tests, and a CLAUDE.md gotcha, all to
produce sounds the recorded *chalk* theme already covers with the same
grammar. Every one of those costs is about **code in the client**. None of
them is about the sound, and the sound is the one thing the table could not
be re-derived into: warm friction with no pitch anywhere in it, tuned by ear
across two phases against a bench that no longer exists.

So 102-3 separates the two. `tools/render-classic-theme.mjs` reimplements the
deleted `synth.ts` once — the pink-noise source, the swept bandpass, the
octave-down body band, the stick-slip grain modulator, the contact tick, the
attack/drag/lift envelope, and the `StrokeSpec` table copied verbatim with the
comments that defend each number — evaluates the whole graph per sample under
a seeded PRNG, and writes ten WAVs into `web/assets/sounds/chalk-classic/`.
From there it is an ordinary theme: a folder, an import block, a
`SoundThemeId`, a `SOUND_THEMES` row. The client gained no filters, no
`AudioContext` graph and no invariants; `themes.test.ts` covers the new folder
the same way it covers the other four.

Decisions worth keeping:

- **Deterministic render.** The synth called `Math.random` four times per
  stroke — the noise, the grain, and two read offsets — so that repeats were
  never bit-identical, "because real chalk never is". A file in git has to
  be, so the tool seeds one PRNG per category. Re-running it reproduces the
  committed files byte for byte, which is what makes the tool a check on the
  files rather than a story about them.
- **One trim for the theme, not one per cue.** The specs' `gain` column is a
  balance *between* the ten sounds, re-derived once by RMS-matching when pink
  noise replaced white; per-file normalization would throw exactly that away.
  Every cue is scaled by the same factor, set so the loudest lands at
  −6.4 dBFS — the *chalk* theme's ceiling to the decibel, which also puts the
  mean per-cue RMS within 0.2 dB of chalk's. The synth ran an order of
  magnitude below full scale and the authored themes do not, so an untrimmed
  render would have made this theme a switch to near-silence.
- **The screech ceiling is checked on audio now, not on the table.** The
  synth's tests asserted `lowpassHz < SCREECH_FLOOR_HZ` and `q <= MAX_Q` over
  a spec table that is no longer code. The tool's `--spectrum` mode replaces
  them with the measurement they were a proxy for: energy by octave, and the
  share at or above 5200 Hz. It is 0.00 % for all ten cues.
- **Seven specs are not rendered.** `mention`, `dm`, `thread_reply`, `voice`,
  `channel_added`, `friend_request` and `governance` all map to
  *new message* in `CUE_FOR`, so they have nowhere to sound. `message` — the
  shortest and quietest spec, the one written for the category that fires all
  day — becomes `10_new_message`. The seven remain in the tool, unrendered,
  and would be the material for the "distinct mention cue" follow-up below,
  which for this theme is a re-run rather than a recording session.
- **Stereo from a mono synth.** Both channels carry the same samples; the
  theme format is stereo and the synth was not.

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

102-3 adds one, and it is the only thing about that slice a test cannot
answer:

- [ ] *chalk classic* is heard against the synth as it was. The render is
      the same arithmetic as the WebAudio graph, but "the same arithmetic"
      is a claim about biquad conventions (the spec reads Q in decibels for
      lowpass and highpass, linearly for bandpass) and about a per-sample
      sweep against Chrome's per-quantum one. If a cue sounds wrong, the
      tool prints its levels and its spectrum; the spec table is not the
      suspect.

## Left open

- **Default volume against the recordings' level** — see the checklist.
- **Compressed cues.** If image size ever matters, an Opus/OGG conversion
  step with ffmpeg in the frontend build stage; browsers decode both through
  the same `decodeAudioData`.
- **A distinct mention cue.** One new file per theme plus a `ThemeCue`; the
  `CUE_FOR` rows for `mention` and `dm` move. Same shape as phase 87's
  reminder cue.

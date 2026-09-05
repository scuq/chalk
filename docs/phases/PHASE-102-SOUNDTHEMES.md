# Phase 102 — sound themes

**Status:** 102-1 … 102-4 shipped; the phase is closed unless a follow-up
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
  cue files (WAV since 102-1, MP3 also since 102-4; each under two seconds)
  plus the theme's own `MANIFEST.md`. `notify/theme-assets.ts` imports every one; esbuild's file
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
- **102-4** — *arcade* replaces the recorded *chalk* theme and becomes the
  default; the cues are romainsimon/uisfx's MIT-licensed arcade pack, shipped
  as upstream's own MP3s. `.mp3` loaders in `build.mjs` and `test.mjs`, an
  MPEG frame walker in `themes.test.ts`, `audio/mpeg` in `contentTypeFor`.
  See below.

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

## 102-4 — arcade, and the end of the recorded chalk theme

scuq asked for a theme built from [romainsimon/uisfx](https://github.com/romainsimon/uisfx)'s
*arcade* pack, to replace *chalk*. Replace literally: `web/assets/sounds/chalk/`
is deleted, the id is gone from `SoundThemeId`, and `arcade` is the new
`DEFAULT_SOUND_THEME`. A device whose stored pref still says `"chalk"` gets the
default back through `normalizeSoundPrefs`'s unknown-id fallback — the path
102-1 built for exactly this and had never yet needed.

Decisions worth keeping:

- **Upstream's files, unmodified.** uisfx publishes MP3 and OGG, not WAV, and
  there is no ffmpeg, sox or any other decoder on the build box. Rather than
  add a system dependency, or drive the e2e Chromium's `decodeAudioData` to
  transcode, the MP3s ship exactly as published: byte for byte, no resample,
  no re-level. That is also the better answer on the merits — MIT wants its
  notice to travel with *the files*, and the ones chalk serves are then
  literally the ones the licence was granted for. 45 KB against the ~600 KB a
  WAV transcode would have cost, and no lossy→PCM generation step.
- **A cue file is now WAV *or* MP3.** `.mp3` joins the esbuild file loader in
  `build.mjs` and the empty loader in `test.mjs`; `player.ts` needed nothing,
  since it fetches bytes and hands them to `decodeAudioData`, which takes both
  and resamples to the context's rate. `contentTypeFor` in `spa.go` gains
  `audio/mpeg` — not load-bearing (a fetch ignores the type, and upstream's
  files carry an ID3 tag that Go's sniffer recognises anyway), but a re-export
  without that tag would quietly become `application/octet-stream`.
- **The duration ceiling holds, by walking MPEG frames.** An MP3 has no length
  field, so `themes.test.ts` sums frames × 1152 samples and divides by the
  header's rate. It is restricted to MPEG-1 Layer III and throws on anything
  else rather than measure it against the wrong bitrate table: a silently
  mismeasured duration would be worse than a failing test. Walking the frames
  is also the only check that the file is whole, which a WAV gets for free
  from its data-chunk size. The sample-rate and bit-depth pins do **not**
  apply to MP3 cues — arcade's are 44.1 kHz mono, and pinning a publisher's
  encode would be pinning something chalk does not control.
- **The mapping is the only editorial act.** uisfx names its sounds for a
  shopping-and-dashboard vocabulary chalk has no use for, so scuq gave the
  ten: `success` → friend online, `add-to-cart`/`remove-from-cart` → your own
  call join and leave, `wake`/`sleep` → other people arriving and leaving,
  `connect`/`disconnect`, `typing` → send confirmed, `error`, `notification` →
  new message. The pack's connection cue is called `connect`, not `connected`.
  The folder's `MANIFEST.md` records each cue's upstream filename so the
  mapping is legible without a checkout of uisfx.
- **Attribution in the repo, not only in a doc.** `LICENSE.uisfx` sits in the
  theme folder, so it is in the image and beside the files it covers. The
  manifest and `docs/notification-sounds.md` both name the project and thank
  it.
- **chalk-classic keeps its id.** With the recorded *chalk* theme gone it is
  the only theme left with the chalk-on-a-board grammar, which makes the name
  more accurate rather than less. Its manifest's level note used to cite
  chalk's ceiling; it now cites the family's, which is the same −6.4 dBFS
  (empir) and −6.2 (runestone). The trim constant does not move — re-deriving
  it would rewrite ten committed files to change nothing.

### Rejected in 102-4

- **Transcoding to WAV** (via an installed ffmpeg, or the e2e Chromium).
  Either would have kept the folders uniform at the cost of a build-box
  dependency, a lossy→PCM step, and an attribution that covers files nobody
  published.
- **Shipping the OGGs instead.** Smaller again, and their duration is easier
  to read (the last page's granule position). But Safari's `decodeAudioData`
  has never reliably taken Ogg Vorbis, and chalk runs on iPhones.
- **Keeping `chalk` alongside `arcade`.** Asked for and answered: replace.

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

102-3 and 102-4 add these, and they are the only things about those slices a
test cannot answer:

- [ ] *chalk classic* is heard against the synth as it was. The render is
      the same arithmetic as the WebAudio graph, but "the same arithmetic"
      is a claim about biquad conventions (the spec reads Q in decibels for
      lowpass and highpass, linearly for bandpass) and about a per-sample
      sweep against Chrome's per-quantum one. If a cue sounds wrong, the
      tool prints its levels and its spectrum; the spec table is not the
      suspect.
- [ ] *arcade* is the theme a fresh device gets, and a device whose stored
      pref still says `chalk` lands on it too rather than on silence.
- [ ] the arcade cues sit at a sane level against the other four at the
      default volume. They were not re-levelled — upstream's mastering is
      whatever it is, and nothing in the repo measures an MP3.

## Left open

- **Default volume against the recordings' level** — see the checklist.
- **Compressed cues.** If image size ever matters, an Opus/OGG conversion
  step with ffmpeg in the frontend build stage; browsers decode both through
  the same `decodeAudioData`.
- **A distinct mention cue.** One new file per theme plus a `ThemeCue`; the
  `CUE_FOR` rows for `mention` and `dm` move. Same shape as phase 87's
  reminder cue. Cheapest it has ever been: uisfx publishes a `mention.mp3`,
  and chalk-classic has an unrendered `mention` spec waiting in the render
  tool. The three DAW themes are the ones that would need a session.

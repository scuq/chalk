# Phase 115 — flair: an animated chalk, off by default

**Status:** built, 115-1 – 115-6 (2026-09-08), shipped in v0.8.17. Every slice has unit cover
(`node test.mjs`), the server slice an end-to-end HTTP test against a database
(`TestAvatarFrameEndToEnd`), and the seam between the effects and the stylesheet
its own test (`theme-flair.test.ts`). Verified against a running stack: two
users, two channels and a banner, 31 checks on the real DOM (the probe in
`.claude/skills/run-chalk/probes/ui.mjs` at the time) — the checklist below,
all green.
**Tags:** `#flair` → `tools/where.sh -g flair`

## The problem

chalk is deliberately still. Six `@keyframes` in eleven thousand lines of CSS,
and phase 112 wrote "no animation" into the avatar design. That is the right
default for a chat client someone reads for hours — and it leaves nothing for
the reader who *wants* the app to feel alive: to see at a glance that a room is
heating up, to notice a friend arriving without a sound, to wear something
around their picture the way Steam's frames let people, to have a channel's
image breathe rather than sit.

The brief: an optional mode with exactly those four things, off by default,
and nothing about the default experience changed.

## The design

**One switch, per device, written as attributes.** Flair lives in
`display-prefs.ts` beside the font and the scale, for the reason everything
there is per-device: motion is a property of the screen in front of you, and a
flicker that is fun on a monitor is a battery cost on a phone. `applyDisplayPrefs`
writes `data-flair` and one `data-flair-<effect>` per sub-switch on `<html>`,
so every effect is a CSS rule gated on an attribute and most of the phase
needed no prop drilling at all. The four sub-switches default *on* under a
master that defaults *off*, so "turn on flair" lights everything and each
effect can still be put out alone.

**Reduced motion wins, in CSS only.** One `@media (prefers-reduced-motion:
reduce)` block closes the flair section and turns every flair animation off,
leaving each effect's resting shape. There is no override for it. The policy
is written down in `docs/theming.md` ("Motion policy") for the first time;
the four pre-115 reduced-motion blocks were the convention without a name.

### The flame is a sticky verdict over live pushes

`burst-store.ts` is a module singleton with its own clock, on the
`typingStore` shape and for its reasons: the reducer is pure and cannot hold a
timer, and nothing here should survive a reload. It remembers the last N
arrival times per channel and calls a channel hot once N land inside the
window — then keeps it hot until the window has passed since the *last*
message. Counting strictly would put the flame out and relight it as the
oldest message of a burst slid out of the window; sticky reads as a signal,
strict reads as a fault.

It is fed from the live `TypeMessage` push only, before the decrypt (a message
you cannot read yet is still a message), and never from history — `noteSound`'s
rule, for `noteSound`'s reason: history would light every room on every
reload. **Your own messages do not count on the device that sent them**: the
server skips the sender's connection, so the optimistic row never comes back
as a push. That is the right behaviour — the flame says a room is heating up
around you, not that you type fast — and other devices of your account do
count. Reconfiguring the threshold re-derives every verdict from what is
already remembered, so lowering the count lights a flame at once.

### The wave is a keyed remount

`wave-store.ts` holds a start time per person for `WAVE_MS`. The two triggers
are things App already detects: the friend-came-online transition (the same
two guards the presence sound uses, so a reconnect's roster seed does not wave
everyone) and a `dm` event on the notify bus, skipped while that very
conversation is on screen. `WaveName` renders plain text until a wave runs,
then one inline-block span per letter with `key={startedAt}` on the wrapper,
so a second trigger remounts and restarts the animation. The per-letter delay
is sixteen `:nth-child` rules in the sheet — **not** a custom property set
inline, which `nickcolor.ts` records as a WebKit trap this codebase already
walked out of. Letters past sixteen share the last delay; the wave has
visibly passed by then.

### The frame is the wearer's, seen by everyone, drawn by the viewer

scuq's call, over a viewer-local frame derived from the nick hue: a frame is
meant to be seen, so it is an account field. `users.avatar_frame` (migration
0061, `TEXT NOT NULL DEFAULT ''`, a length cap rather than an enum so a new
style is not a migration) rides on the user directory the hover cards already
fetch and on `/api/auth/me` for your own; `PUT /api/auth/avatar-frame` sets it
against a server-side allowlist that `frames.test.ts` holds identical to the
client's list. The picture itself stays encrypted per channel; the frame is a
style name, and encrypting it would be theatre.

On the client `Avatar` gains `userID` and looks its frame up through the same
module cache as display names (`useAvatarFrame`), which repaints when the
directory lands; the caller passes `frame` explicitly only for your own
picture, which the directory omits. The frame is `data-frame` on the `<img>`
and CSS draws it with `outline` and `box-shadow` — an image has no
pseudo-elements, and a wrapper would cost the feed its 1em rule — under
`data-flair-frames`. **Never at the feed's line size**: 112's rule stands.

A changed frame reaches other people on their next reconnect (App now calls
`refreshDirectory()` there) or reload, exactly as a display name does. There is
no push for it.

### The banner drifts on `translate` and `scale`, not `transform`

`BannerBand` sets `transform: scale(zoom)` inline for a filled band. A
`transform` keyframe would replace it; the individual `translate` and `scale`
properties compose with it, so the drift is ±1.5% and 1.00→1.04 over forty
seconds on those, and the band's `overflow: hidden` clips it. The editor's
preview is excluded (it drags the picture to set the focus point, and a
drifting target would make the focus lie), and poster art is excluded (it is
shown whole by definition) — its colour wash breathes instead.

## What was rejected

**A viewer-chosen frame style, tinted per person from the nick hue.** No
server change and it ships in one slice, but it is not what a frame is: the
whole point is that the wearer picked it. Offered, declined.

**A websocket push for frame changes.** Store, proto, ws handler, reducer —
the full vertical slice `display-names.ts` already declined for the name. The
directory refetch on reconnect closes most of the gap for a cosmetic.

**An inline `--i` custom property per letter** for the wave's delay. Preact
would apply it through `setProperty`, which is not the `cssText` path the
nickcolor note warns about, but it would be a third inline-custom-property
pattern in a codebase whose one precedent exists to warn against them, and it
costs a `setProperty` per letter per render. Sixteen CSS rules cost nothing.

**Frames as a wrapper element around the picture.** Would allow a rotating
conic-gradient ring; would also change the box every avatar site lays out and
break 112's "not a pixel taller in the feed" contract. Outline and box-shadow
on the image are enough at 16–44px.

**Gating the reduced-motion block behind a "move anyway" override.** Someone
who told their OS they want less motion has said so; the phase does not argue.

**Sweeping the five pre-115 keyframes that lack a reduced-motion guard**
(the connecting-dot pulse, the message flash, the padlock pulse, the spinner,
the lazy dots). Real, and out of scope: ask before widening.

## The slices

- **115-1 — the switch, the prefs, the burst model, the settings section.**
  Seven fields on `DisplayPrefs` with clamps (`MIN_/MAX_BURST_COUNT`,
  `MIN_/MAX_BURST_MINUTES`), `StyleTarget` widened to set and remove
  attributes, `burst-store.ts` with `useHotChannels`, a `flair` section on the
  appearance tab findable by "flame", "motion", "reduced motion" and the like.
  - **One thing the plan did not foresee:** the first cut of `sweep` compared
    the flame's end time against "now" *before* deciding whether it had been
    lit, so a flame that expired exactly on the sweep went out without telling
    anyone. The test caught it; the store now notifies on the transition it
    records, not the one it recomputes.
- **115-2 — the flame.** `Flame.tsx` — one inline SVG, the `UnreadDot`
  precedent — beside the dot in the sidebar row (a busy DM lights it on the
  friend's row, since a DM is a channel too) and the phone's conversation
  list, and beside the title in the channel header. Fed at the `TypeMessage`
  push, cleared with the typing store on a socket drop.
- **115-3 — the wave.** `wave.ts` (`splitLetters`, `WAVE_MS`,
  `WAVE_MAX_LETTERS`), `wave-store.ts` with `useWaves` (one subscription for
  both rosters), `WaveName.tsx`, the two triggers in App.
- **115-4 — the banner drift.** CSS only. `theme-flair.test.ts` holds every
  animated flair selector to the reduced-motion block, the drift away from
  the editor's preview, and the wave's delay rules to `WAVE_MAX_LETTERS`.
- **115-5 — the frame on the server.** Migration 0061; `User.AvatarFrame`
  through `userCols`/`scanUserRow` and `DirectoryUser` (three sites each);
  `UpdateAvatarFrame`; the field on `/api/users/directory`, `/api/users/lookup`
  and `/api/auth/me`; `PUT /api/auth/avatar-frame` with `AvatarFrames` as the
  allowlist. `TestAvatarFrameEndToEnd` and `TestUsersUpdateAvatarFrame`.
- **115-6 — the frame on the client.** `avatars/frames.ts`, the
  `avatar-frame-api.ts` binding, `me_avatar_frame_set`, the directory cache
  widened to a second map with `useAvatarFrame` and `refreshDirectory`,
  `Avatar` drawing `data-frame`, `userID` passed at the roster, hover-card,
  members, and call-tile sites and `frame` at the status bar, the picker in
  the flair section, three frames in CSS.

## Left open

- **The live-stack checklist** (run 2026-09-09, 31/31), kept here as the
  regression recipe — two users A and B, friends, sharing a channel that has a
  banner:
  1. Flair off: no `[data-testid=flair-flame]`, no `data-frame` on any
     `.chalk-avatar`, the banner image's computed `animation-name` is `none`.
  2. A turns flair on; B sends four messages within four minutes → a flame on
     A's roster row and in the header; A sends four → no flame on A's own
     device. Count lowered to two in settings → flame after two.
  3. B goes offline and back → `[data-testid=flair-wave]` inside B's roster
     name on A's screen, gone after ~2.5 s. B sends A a DM while A reads
     another channel → wave; while A reads that DM → none.
  4. B picks *ember*; A reconnects or reloads → `data-frame="ember"` on B's
     `<img>` in A's roster and hover card; not on the feed's line avatar.
  5. `emulateMedia({ reducedMotion: "reduce" })` → every `chalk-flair-*`
     animation resolves to `none`; the flame and the rings are still drawn.
  - Two things the run taught: the picker's native radio is hidden by the
    theme-picker CSS, so a probe clicks the label; and 112's fan-out reached
    only the DM in that run (the two fresh channels' uploads were skipped as
    "no key here yet"), so the feed-line check has to look in whichever
    channel the picture actually landed.
- **A `profile_changed` push**, if the reconnect-time refetch turns out to be
  too slow for frames to feel live.
- **The five unguarded pre-115 keyframes** (see "What was rejected").
- **Frames in Zuckermode's friend rows** — there is no avatar there to frame.
- **The 93-3 `useDisplayPrefs` double-mount hazard** is unchanged by the new
  fields; the panel and App both already mount the hook.

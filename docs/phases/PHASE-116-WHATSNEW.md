# Phase 116 — what's new: the note after an update, and the ask that never came

**Status:** built, 116-1 – 116-2 (2026-09-09), shipped in v0.8.17. Verified against a running
stack: a fresh account plus one friend and one channel, 12 checks on the real
DOM (the probe in `.claude/skills/run-chalk/probes/ui.mjs` at the time) — the
note on first load, back on reload unticked, the picture ask following it,
the tick remembered, the reopen from settings → about.
**Tags:** `#whatsnew` → `tools/where.sh -g whatsnew`

## The problem

Two of them, found together while getting phase 115 ready to ship.

**The picture ask did not always come.** 112-6's nudge — "add a picture?",
once per person — was reported as appearing only sometimes. The effect that
schedules it set its "shown" mark *when it armed the timer*, and it re-ran
whenever the channel list changed, which the list does several times in the
first seconds after a load. Each re-run's cleanup cancelled the pending timer;
the mark stayed set; the ask never opened, and `avatarAsked` was never
written, so the next load did the same dance. Whether a given person ever saw
it depended on how quiet their first 2.5 seconds were.

**Nobody is told what changed.** Flair is off by default on purpose, which
means that without being told, nobody will find it. The changelog is a file on
github, and a chat client is not where anyone reads one. chalk needed a way to
say "here is what is new" to a person, once, in the app — and *once* has to
mean "until they say they have read it", not "until they clicked it away".

## The design

### 116-1 — the ask's mark moves to the moment it opens

A surgical fix: `nudgeShownRef` is set inside the timeout callback, beside
`setNudgeOpen(true)`, instead of when the timer is armed. A cancelled timer
now leaves no mark, and the next re-run arms it again; the last re-run — the
one the channel list finally leaves alone — is the one that fires. The ask
also waits for the what's-new note: two questions on one load is a nag, so
it holds while the note is open or still due, and follows once the note is
closed (ticked or not).

### 116-2 — a note keyed by phase, with a tick that is the only answer

`web/src/whats-new.ts` carries a short hand-written entry per phase — a
title, a few lines written for a chalk user, and the settings path — and the
account pref `whatsNewRead` holds the highest phase a person has ticked as
read. On load, once prefs have arrived, the entries above the mark are shown
in one modal (`WhatsNewNudge`, the `AvatarNudge` shape) a beat and a half in.

**Keyed by phase number, not version.** A release is cut after the code (the
`/release` skill names it), so an entry written with the code cannot know its
version; the phase number is known the day the work starts, it is what the
paperwork is filed under, and "newer" is integer order. The list is meant to
hold the last release or two; older entries are pruned at release time, and
anyone that far behind has the changelog link in the same panel.

**Closing is not reading.** The close button, the backdrop and the × all hide
the note for the session and write nothing; it comes back on the next load.
The tick — "I've read this, don't show it again" — is what writes the pref,
and it is a checkbox rather than a button so the state is visible and
reversible: settings → about has a *what's new* button that reopens the note
with the whole list and the tick set, and un-ticking it there brings the note
back next time. The mark is parsed defensively (`parseWhatsNewRead`): a
corrupt pref reads as "nothing read" and shows the note, never hides it.

**Account prefs, not localStorage**, for 112-6's reason: per device it would
show again on every new browser, which is precisely the nagging the tick is
there to end.

## What was rejected

**Reading the changelog itself.** It is in the repo, and the bundle could
embed it; but it is written per version, it is long, and a modal that scrolls
is a modal that gets closed unread. A per-phase note is five lines by hand.

**Forcing the tick** (a note that cannot be closed until it is ticked). It
would make the tick meaningless — people tick to make things go away — and
chalk does not lock a person out of their chat to make them read a memo.

**A "later" button that snoozes for a day.** It is what closing already does,
per session, without a clock to store.

**Folding the picture ask into the note** as a line. The ask has a file input
and a crop dialog behind it; a line of text does not. It stays its own
modal, and simply waits its turn.

## The slices

- **116-1 — the picture ask, fixed.** The mark moves into the timeout; the
  effect gains the two what's-new gates; the reason is in the comment beside
  it.
- **116-2 — the what's-new note.** `whats-new.ts` (`WHATS_NEW`,
  `latestWhatsNew`, `unreadWhatsNew`, `parseWhatsNewRead`, with
  `whats-new.test.ts`), `WhatsNewNudge.tsx`, `UserPrefs.whatsNewRead`, the
  open/close/mark wiring in App, the *what's new* button in the about section
  (findable by "what's new", "news", "update"), and the first entry: phase 115.

## Left open

- **Pruning the list at release time** is a hand step: when cutting a release
  that is more than one or two behind the oldest entry, drop the old ones.
  The `/release` skill could carry a reminder; not added here.
- **A note per release rather than per phase**, if releases ever bundle many
  phases and one modal grows long. The key would stay the phase; only the
  grouping would change.

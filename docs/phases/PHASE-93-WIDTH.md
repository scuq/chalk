# Phase 93 — the full-width layout

**Status:** **shipped** — 93-1 carries the feature; 93-2 rebalanced the thread
panel against it, found by looking at the result rather than planned here.
Everything under [Left open](#left-open) is deliberately not built.

**Tag:** `#fullwidth` → `tools/where.sh -g fullwidth`. (Not `#width`: every
CSS `width:` in the repo matches that, and a tag that returns 500 hits is not
a locator.)

## The problem

The app shell is capped and centred:

```css
.chalk-app--phase08b {
  max-width: 1100px;   /* theme.css:307 */
  margin: 0 auto;      /* inherited from .chalk-app */
}
```

On a laptop that is the right call and always has been — 1100px is close to a
comfortable reading measure once the sidebar takes its column. On anything
wider it stops being a choice about readability and becomes wasted screen:

- On a 2560px monitor **more than half the window is empty background**, and
  the roster, the feed and the thread panel are all squeezed into the same
  1100px they had on a 13" laptop.
- The thread panel (340px, fixed) and the sidebar (`chat.sidebarWidth`,
  180–420px) come out of that budget, so opening a thread on a wide screen
  narrows the conversation that the thread is *about* — while the space to its
  right sits unused.
- Every other layout knob chalk has — sidebar width (33-4), composer height
  (91-1), text size and font (34-1, 70-5) — is a preference. The one number
  that decides how much of the screen the app is allowed to use is a constant
  in the stylesheet.

Nobody can opt out of it today, and the workaround people reach for — zooming
the browser out — is the wrong tool: it shrinks the text to buy the width.

## The design

One per-device preference, one custom property, one CSS line.

### The pref lives on the device, not the account

`appWidth` joins `font`, `scale` and `hideScrollbars` in
`web/src/display-prefs.ts` — localStorage under `chalk.display.v1`, never sent
to the server.

That is the split display-prefs already draws, and this setting is exactly
what it was drawn for: the file's own header says the point is that "the phone
and the desktop disagree". Whether the app should fill the window is a fact
about the **screen in front of you**, not about you. The 34" ultrawide wants
full width; the same account on a 13" laptop wants the centred column, and
syncing the answer would make one of the two wrong every time you switch.
The theme is account-synced because taste travels; this is hardware, so it
does not.

```ts
export type AppWidth = "centered" | "full";

export interface DisplayPrefs {
  font: FontChoice;
  scale: number;
  hideScrollbars: boolean;
  appWidth: AppWidth;   // "centered" is the default -- today's layout
}
```

An enum rather than a boolean, and two members rather than three. The name
`centered` says what the current layout *is* (not merely "not full"), and a
third step — a wider fixed column, say 1600px — is a value away if anyone
wants one, where `fullWidth: true/false` would have had to be migrated. Two is
what the request needs; adding a third on speculation is not.

`normalizeDisplayPrefs` treats an unknown or missing value as `"centered"`, on
the same reasoning as the existing font and scale handling: a hand-edited
localStorage entry must not be able to render the app strangely.

### Applied as a custom property, like every other display pref

`applyDisplayPrefs` sets one more inline property on `<html>`:

```ts
el.style.setProperty(
  "--chalk-app-max-w",
  prefs.appWidth === "full" ? "none" : "1100px",
);
```

and the shell reads it:

```css
.chalk-app--phase08b {
  max-width: var(--chalk-app-max-w, 1100px);
}
```

The fallback is the current value, so the app renders correctly on the first
paint before `applyDisplayPrefs` runs (and for anyone whose localStorage is
unreadable — private-browsing throws, and `loadDisplayPrefs` already swallows
it). `margin: 0 auto` stays: at `max-width: none` centring is a no-op, so
there is nothing to undo.

Only `.chalk-app--phase08b` is touched. The bare `.chalk-app` rule above it
still says `max-width: 900px`, but `App.tsx` has rendered both classes
together since phase 08b — that 900px is a relic that never wins. Leave it
alone: deleting it is a separate tidy-up, and doing it here would mean this
slice's diff no longer reads as one change.

### Mobile is already full width, and stays that way by construction

The `@media (max-width: 767px)` block sets `max-width: none` on
`.chalk-app`, `.chalk-app--phase08b` and the thread-open variant — the same
selectors, later in the file, so it wins over the custom property no matter
what the pref says. Nothing about phones has to be special-cased in JS, and
the pref cannot break the mobile layout even if it is set from a phone.

What it *can* do is confuse: a control that visibly does nothing is worse than
no control. So the section hint says it plainly — on a narrow window the
layout already fills the screen.

### The extra space goes to the conversation

`.chalk-main` is the `1fr` column of the shell grid, and it is the only
flexible one — the sidebar is sized by its own pref, the thread panel was a
fixed 340px — so **all** the space unlocked by removing the cap lands in the
feed.

That does not make the thread panel free. It still takes a column and a gap out
of the conversation, in either mode; what changes is the budget it comes out
of. At 1920px the feed goes from ~836px centred to ~1656px full — so the panel
stops being the difference between a readable conversation and a squeezed one,
which is the honest version of the claim.

**93-2 changed what that column costs.** A flat 340px next to a 1656px feed is
its own imbalance — a letterbox of wrapped replies, with a reply composer
squeezed under it, beside six times its width of empty feed. The panel is now
`clamp(340px, 28%, 560px)`. The percentage resolves against the *shell's*
content box, not the viewport, which is what makes one line cover both modes:
in the centred 1100px column 28% (≈299px) is under the floor, so nothing moves;
a full-width shell has room, so at 1920px the panel takes 529px and the feed
keeps 1115px. The 560px ceiling stops an ultrawide handing the panel more than
a column of short replies can use.

What does *not* stretch is media, and that is already handled: attachments cap
at `min(720px, 100%)` (theme.css:1410), code cards at `44rem`, link-preview
cards and the giphy picker at their own widths. Wide mode widens **the text
rows, the header and the composer**; a photo does not become a billboard. This
is worth stating because it is the thing that would have needed work and does
not.

Not the roster: `.chalk-sidebar` is the fixed `--chalk-sidebar-w` column and
keeps exactly the width its own pref gives it. The composer is on the list
because `.chalk-footer` is a second grid with the same `sidebar-w / 1fr`
split, so the field stretches with the feed above it — see
[Left open](#left-open), where whether it *should* is the open question.

### The control

A `<select>` in the appearance section of the profile panel, directly under
**text size** — its nearest sibling in both shape and meaning:

```
layout width   [ centered (default) ▾ ]
               [ full window          ]
```

`settings-nav.ts` gains the keywords someone would actually type for it:
`width`, `full width`, `wide`, `fullscreen`, `layout`, `column`, `margins`,
`ultrawide`. The appearance section's existing hint already explains that font
and text size are per-device; `appWidth` joins that sentence rather than
adding a second one.

## What was rejected

- **A synced pref (`chat.appWidth`).** Would ride the existing prefs frame and
  need no new storage — but see above: it would follow you onto a screen where
  the answer is different. The sidebar-width precedent is not the right one
  here; sidebar width is a taste that survives a change of monitor, and this is
  not.
- **A viewport breakpoint that widens the cap automatically** (e.g.
  `max-width: min(1100px, ...)` growing past some width). No preference, no
  control, no way to disagree — and it would move the layout under people who
  are happy with it. The complaint is not "chalk guesses wrong", it is "chalk
  does not ask".
- **Capping the message text at a reading measure in full mode.** Tempting —
  100+ character lines are genuinely harder to read — but it directly
  contradicts the request. Someone who turns on full width and gets a 1100px
  text column inside a 2560px shell has been given a setting that lies. If it
  turns out to be needed, it is its own opt-in (see below), not a silent rider
  on this one.
- **A drag handle on the shell edge**, the way 33-4 and 91-1 resize the
  sidebar and composer. There is no border to grab — the shell's edge is the
  window's — and the setting is two states, not a continuum.

## Slices

| slice | what it lands |
| --- | --- |
| 93-1 | `appWidth` in `display-prefs.ts` (type, default, normalize, apply), `--chalk-app-max-w` on `.chalk-app--phase08b`, the appearance select in `ProfilePanel.tsx`, `settings-nav.ts` keywords, `display-prefs.test.ts` cases, a `CHANGELOG.md` bullet, the reworded comments (below), and the phase-state bookkeeping (below). |
| 93-2 | the thread panel's share: `clamp(340px, 28%, 560px)` on the thread-open grid, one line in `theme.css`. Found by looking at 93-1 running at 1920px — the balance complaint the plan did not anticipate. No JS, no pref, and centred mode is unchanged by construction. |

### The bookkeeping is part of the slice

93-1 is the only slice, so the change set that lands it is also the one that
stops phase 93 being a plan. Four edits, none of them optional — a doc that
still says a shipped thing is unbuilt is exactly the drift CLAUDE.md calls
worse than a missing entry:

- **this file** — `Status:` flips from *planned, not started* to shipped;
- **`docs/phase-log.md`** — drop `— **planned, not started**` from the row;
- **`CLAUDE.md`** — remove phase 93 from *Next candidates* (it is not a
  candidate once it exists);
- **`docs/tags.md`** — `#fullwidth` changes from `-` to `93`, and gains its
  real paths: `web/src/display-prefs.ts web/src/theme.css
  web/src/components/ProfilePanel.tsx docs/phases/PHASE-93-WIDTH.md`.

All four go in the proposed `git add` list beside the source.

### The comments that have to change with it

`theme.css:9829`, the window-controls-overlay block, explains why the header
leaves the centred column *in terms of the 1100px cap*: "`.chalk-app` is
max-width:1100px and centred — so on a wide monitor the column starts well
right of the traffic lights". In full mode the column already spans the
window, so that reasoning describes only one of two possible layouts. The
behaviour is unchanged and correct in both; the comment has to say so, or it
becomes exactly the kind of misleading documentation CLAUDE.md says to remove.

`docs/phases/PHASE-36-PWA.md:41` repeats the same claim about the same
override, and drifts for the same reason.

`web/src/chat/sidebar-width.ts:11` is the third: it justifies the 420px
sidebar maximum by noting that the thread panel "takes a fixed 340px of the
same 1100px shell". The clamp is absolute px and stays correct — but its
stated reason now holds only in centred mode, where it is also the mode that
needs it. One sentence in each of the three.

## How it gets verified

**Ran clean at 93-1** (`node test.mjs` 1243/1243, probe 14/14: 1100/836
centred, 1920/1888/1656 full, 1304 with a thread open, 390px either way on the
phone) **and again at 93-2** (probe 16/16, with the thread-open numbers now
529/1115 in full mode and centred held at exactly 340). The grid arithmetic and
the stylesheet agree.

- `node test.mjs` — `display-prefs.test.ts` extended: default is `centered`,
  an unknown / missing / non-string value normalizes to `centered`, a stored
  `full` round-trips, and `applyDisplayPrefs` sets `--chalk-app-max-w` to
  `none` and `1100px` respectively (the existing `StyleTarget` stub covers
  this without a DOM). `settings-nav.test.ts` gains a filter case for "full
  width".
- The layout half cannot live in a `*.test.ts`, so it is a `probes/ui.mjs` run
  against the dev stack (`.claude/skills/run-chalk`), at a 1920px viewport with
  the sidebar left at its 220px default. The numbers below are what the grid
  arithmetic predicts; the probe asserting them is what proves the CSS agrees.

  - **The shell.** `.chalk-app`'s measured width is **~1920px** in full mode
    and ~1100px in centred. Not "the viewport minus the gutters": the global
    `box-sizing: border-box` (theme.css:211) puts the `var(--chalk-s4)` padding
    *inside* the box, and `html, body` have no margin, so at `max-width: none`
    the border-box width is the viewport itself. The gutters show up in the
    content box (1888px) — measure that instead if the padding is what is in
    question, but do not expect it from `getBoundingClientRect()`.
  - **The feed.** `.chalk-main` at ~1656px in full mode against ~836px
    centred, thread closed. That difference is the feature.
  - **The thread panel still costs a column**, and the criterion has to say so.
    Full width buys a bigger starting number, not an exemption from the panel.
    What is checkable, and what the phase actually claims, is the comparison:
    **full + thread open is wider than centred + thread closed** — i.e. in full
    mode the thread panel no longer costs you the conversation.

    Since 93-2 that column is `clamp(340px, 28%, 560px)`, so the criteria are
    a ratio rather than a constant: in full mode at 1920px the panel measures
    **529px** against a **1115px** feed — past its floor, inside its ceiling,
    and roughly 1:2 against the feed. **Centred mode must still measure exactly
    340px** and still lose 352px of feed, because that is the case where the
    percentage falls under the floor; a probe that does not check it would miss
    93-2 regressing the layout it was supposed to leave alone.
  - Switching the select changes all of this live; it survives a reload; and
    under iPhone emulation both settings render identically.
- Full chain before it is done: `go build ./... && go vet ./...`,
  `go test ./...`, `gofmt -l .`, `npx tsc --noEmit`, `node test.mjs`,
  `node build.mjs`. No server code is involved — no migration, no wire frame,
  no env var — so the Go half is a regression check, not a change.

## Left open

- **A reading measure.** If long lines turn out to be the real cost of full
  width, the answer is a *second, separate* opt-in — a `--chalk-measure` cap on
  the message text column only, off by default, so "full width" keeps meaning
  full width. Do not fold it into `appWidth`.
- ~~**Whether the composer should stretch.**~~ **Decided by looking (93-1):
  it stretches, and stays that way.** At 1920px the field is indeed ~1656px
  wide, but in the screenshot it reads as the same edge the header rule and the
  message rows already run to — capping it would put a short line back in the
  middle of an otherwise full-width shell, which is the same lie this phase
  refuses for the message text. The cap remains one `max-width` on
  `.chalk-composer--railed` if anyone disagrees after living with it.
- **A third step (`wide`, ~1600px)** for people who want more than 1100 and
  less than everything. The enum is shaped for it; nothing else has to change.
- **Thread-panel width as a pref**, the way 33-4 made the sidebar draggable.
  93-2 deliberately did not: `clamp(340px, 28%, 560px)` needs no control
  because it already answers differently on a laptop and an ultrawide, and a
  drag handle here would be a second knob for the same question the layout
  pref just settled. If the 28% turns out to be wrong for someone, that is the
  argument for the pref — not a reason to build it in advance.
- **Zen / focus mode** — hiding the sidebar entirely — is a different feature
  that people often ask for in the same breath. Not this phase.
- **`.chalk-app`'s dead `max-width: 900px`** (theme.css:284) and, with it,
  whether the bare class is worth keeping at all now that `--phase08b` is
  unconditional. Deferred cleanup, not part of 93-1.

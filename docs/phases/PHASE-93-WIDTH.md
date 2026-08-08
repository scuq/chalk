# Phase 93 — the full-width layout

**Status:** **93-1 and 93-2 shipped; 93-3 is designed and not started.** 93-1
carries the feature, 93-2 rebalanced the thread panel against it (found by
looking at the result rather than planned here), and 93-3 turns that panel's
width into a drag handle with a device-local pref. Everything under
[Left open](#left-open) is deliberately not built.

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
| 93-3 | **planned, not started** — the thread pane as a drag handle: `chat/thread-width.ts`, a `ThreadResizer`, `threadWidth` in `display-prefs.ts`, the grid track reading `--chalk-thread-w`. Design below. |

### 93-3 — resizing the thread pane

**Status: planned, not started.** 93-2 chose 28% on scuq's behalf. It is a
better guess than a flat 340px, but it is still a guess, and the shape of the
answer depends on what is in the thread — a code review wants a wide pane, a
string of one-line replies does not. Every other pane in the shell that anyone
wanted a different size for ended up with a handle on its edge; this is the one
that did not.

#### The interaction is already written twice

`SidebarResizer.tsx` (33-4) and `ComposerResizer.tsx` (91-1) are the same
component in two orientations, and the sidebar one is the model here almost
line for line: an 8px invisible grab strip straddling the border, absolutely
positioned against a `position: relative` parent, `role="separator"` with
`aria-valuenow/min/max`, `tabIndex={0}`, arrow keys nudging by a shared STEP,
double-click and `Home` to reset, `body.chalk-resizing` pinning the cursor
document-wide, and pointer moves tracked on `window` rather than the element so
a fast drag cannot outrun the handle. Deltas are measured from a `useRef`
origin captured at pointerdown, not from the previous event, so a drag that
leaves the window and returns does not accumulate drift.

Two differences, both real:

- **The sign is inverted.** The sidebar's handle is on its *right* edge, so
  width grows with `e.clientX - origin.x`. The thread pane's handle is on its
  *left* edge, so it grows with `origin.x - e.clientX`.
- **`.chalk-thread-panel` has no `position`**, so it cannot anchor an absolutely
  positioned handle until it gets `position: relative` — the one line
  `.chalk-sidebar` already carries for exactly this reason (theme.css:1554).

Whether that becomes a third copy or a shared `EdgeResizer` is the one thing
this design deliberately leaves to scuq — see [Open questions](#open-questions-for-93-3).

#### The width is device-local, and that is a deliberate break from 33-4

The request is for localStorage, and it is right, but the premise deserves
correcting because the code says otherwise: the channels pane's width is
**not** stored on the device. `chat.sidebarWidth` is a server-synced pref
(App.tsx:628 says so in as many words — "so it follows the user to their other
devices"), and 91-1's composer height rides the same frame. So 93-3 copies the
sidebar's *interaction* while deliberately rejecting its *storage*.

The reason is the one this phase was built on. A thread width is not a taste,
it is a function of how much shell there is to divide — and 93-1 already made
*that* per-device, because the ultrawide and the 13" laptop disagree. A synced
thread width would arrive on the other machine as a number chosen for a shell
that does not exist there, and would fight `appWidth` every time. Syncing it
would reintroduce, one level down, exactly the problem `appWidth` exists to
solve.

So `threadWidth: number` joins `font`, `scale`, `hideScrollbars` and `appWidth`
in `display-prefs.ts`, under `chalk.display.v1`, and never leaves the device.

#### Zero means auto, so 93-2 stays the default

`THREAD_WIDTH_AUTO = 0` in a new `web/src/chat/thread-width.ts`, mirroring
`COMPOSER_HEIGHT_AUTO` and its reasoning verbatim: **a px default would be
wrong at every shell width but one.** Auto is the default and what a reset
returns to, and auto means the 93-2 clamp — so someone who never touches the
handle keeps today's self-balancing behaviour, and someone who drags it once
gets their number until they double-click it back.

The file mirrors `composer-height.ts`: `THREAD_WIDTH_AUTO`, `_MIN`, `_MAX`,
`_STEP`, and a `clampThreadWidth(w: unknown)` that reads anything non-numeric
or non-positive as auto — a corrupt pref looks untouched rather than pinned to
a bound. Starting numbers to sanity-check when it is built: MIN 280, MAX 720,
STEP 16.

#### One track expression covers stored, unset, and too-greedy

```css
.chalk-app--phase08b.chalk-app--thread-open {
  grid-template-columns:
    var(--chalk-sidebar-w, 220px)
    1fr
    clamp(280px, var(--chalk-thread-w, clamp(340px, 28%, 560px)), max(280px, 50%));
}
```

Unset, `--chalk-thread-w` falls back to 93-2's clamp and nothing changes. Set,
it is honoured — but never below the floor and never past **half the shell**,
which is what keeps a 720px width dragged out on an ultrawide from starving a
1100px centred column when the same device switches `appWidth` back. That is
93-2's trick again: the percentage resolves against the grid container, so the
guard is CSS and there is no viewport arithmetic in JS to keep in sync. (`max()`
inside the ceiling keeps `clamp()` well-formed when 50% is itself under the
floor, i.e. on a narrow desktop window.)

#### Where the value is applied, and the bug waiting there

The property belongs on the shell element, inline, beside `--chalk-sidebar-w`
in App.tsx's `shellStyle` (App.tsx:4769) — not in `applyDisplayPrefs`. A drag
writes it once per frame, and the shell is the node that already carries this
kind of value; routing per-frame writes through the prefs hook would persist on
every pointermove. So: `onPreview` sets local drag state (the shell re-renders
with the new inline value), `onCommit` persists once, exactly the split
`SidebarResizer` was built around.

That forces App.tsx to hold `useDisplayPrefs`, and **there is a live hazard in
doing so**: the hook keeps its own `useState` copy, `ProfilePanel` already
mounts an independent one, and `update()` persists
`normalizeDisplayPrefs({ ...prev, ...patch })` — the *whole* object built from
that instance's `prev`. Two instances in one tab therefore clobber each other:
change the font in the profile panel, then drag the thread pane, and App's
stale `prev` writes the old font back. The `storage` listener does not save
this — it only fires for *other* tabs. Nothing today trips it because
`useDisplayPrefs` has exactly one mount.

Whichever fix is chosen has to land *with* 93-3, not after it:

- **Make `update()` read-modify-write from storage** — merge the patch onto
  `loadDisplayPrefs()` instead of onto `prev`. Smallest diff, fixes the whole
  class of bug rather than this instance of it, and costs one localStorage read
  per commit. **Recommended.**
- Lift the hook to App and pass prefs down to `ProfilePanel` as props. Correct,
  but a larger diff through a component that already takes a long prop list.

#### Mobile is a non-question, again

Under 768px the panel is `position: fixed; inset: 0` (theme.css:8688) and there
is no grid column to size, so the handle is gated on `!isMobile` exactly as
`SidebarResizer` is (App.tsx:4998), and the stored width simply does not
participate. Nothing to special-case beyond that one gate.

#### How it gets verified

- `thread-width.test.ts`, mirroring `composer-height.test.ts`: junk and
  non-positive input read as auto, bounds clamp, values round, every offered
  step survives.
- `display-prefs.test.ts`: `threadWidth` defaults to auto, a stored width
  round-trips, junk normalizes to auto — and, if the read-modify-write fix
  above is taken, a case proving a patch does not revert a field it did not
  touch.
- `probes/ui.mjs`, which is where the interaction actually lives: drag the
  handle and assert the panel follows the pointer; the width survives a reload;
  double-click and `Home` return it to the 93-2 clamp; arrow keys step it; the
  handle is absent under iPhone emulation; and a width dragged out in full mode
  does not starve the feed after switching back to centred — the 50% rule is
  the one assertion here that no unit test can make.

#### What was rejected

- **A number in the appearance section** (a select, or a slider beside text
  size). The handle *is* the control, the way it is for the sidebar and the
  composer; a second surface for the same value is a thing to keep in sync for
  no gain. Nothing about `appWidth` argues otherwise — it is a two-state choice
  with no edge to grab, which is precisely why *it* got a select.
- **Syncing it as `chat.threadWidth`.** Would ride the existing prefs frame and
  match 33-4 — and would be wrong for the reason above.
- **Resizing by percentage rather than px.** Survives a monitor change, but no
  drag handle in the app reports percentages and the stored value would stop
  being comparable to `sidebarWidth` or the 340px floor. The 50% ceiling
  already buys what a percentage would.

#### Open questions for 93-3

1. **Copy `SidebarResizer` or extract a shared `EdgeResizer`?** A third
   copy is the point where extraction usually earns itself, and the two
   horizontal handles differ only in the sign of the delta and their labels.
   Against it: the extraction reaches into shipped 33-4 code from a 93 slice,
   which is scope this phase has not asked for. **Recommendation: copy now,
   with extraction as its own follow-up slice** — that keeps 93-3's diff
   readable and leaves 33-4 alone, which is the trade CLAUDE.md's "surgical
   fixes over architectural change" already prefers.
2. **MIN/MAX/STEP.** 280 / 720 / 16 are starting numbers, not measured ones.
   Worth a look at a real thread at 1920px and at 1280px before they are fixed.
3. **Does the floor stay 340px when a width is stored?** The expression above
   drops to 280px once the user takes control, on the grounds that someone
   dragging deliberately narrow has said what they want. The alternative is one
   floor everywhere.

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
- ~~**Thread-panel width as a pref**~~ — **taken up as 93-3** (above). 93-2
  left it out on the grounds that `clamp(340px, 28%, 560px)` already answers
  differently on a laptop and an ultrawide, and that the 28% turning out to be
  wrong for someone would be the argument for a pref. That is what happened,
  and it is worth recording that the argument arrived the same day: a chosen
  ratio is still a choice made on the user's behalf.
- **Zen / focus mode** — hiding the sidebar entirely — is a different feature
  that people often ask for in the same breath. Not this phase.
- **`.chalk-app`'s dead `max-width: 900px`** (theme.css:284) and, with it,
  whether the bare class is worth keeping at all now that `--phase08b` is
  unconditional. Deferred cleanup, not part of 93-1.

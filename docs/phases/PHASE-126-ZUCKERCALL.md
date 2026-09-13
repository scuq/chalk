# Phase 126 — the zucker voice shelf keeps its row, and a call bar for the phone's home screen

Status: 126-1 and 126-2 built (2026-09-13). Unit-tested by
`web/src/theme-zucker.test.ts` and `web/src/voice/duration.test.ts`, which
assert CSS declarations and the duration clock against known input, and
verified under iPhone 14 emulation (see Verification below). Neither slice
has a check on a real phone yet — see the manual checklist below.

Tags: `#zucker`, `#voice` → `tools/where.sh -g zucker`

## The problem

Reported against Zuckermode (62), the phone's home screen, with a screenshot
from an iPhone: the `@ voice` shelf's one room row was cut off mid-row, and
once inside a call there was no control to leave it and no way back to the
room from the conversation list. The second half was already recorded in
`docs/open-items.md` as "Zuckermode has no reachable leave call control," and
before that as the last open item in
[PHASE-95-PHONEVOICE.md](PHASE-95-PHONEVOICE.md#left-open), which built the
shelf and the voice controls band this phase changes around.

## The design

### 126-1 — the shelf gives up its rows

`.chalk-zucker-rows--shelf` (`web/src/theme.css`, near line 10463) changed
from `flex: 0 1 auto` to `flex: 0 0 auto`. The 95-3 comment above it claimed
that flexbox gives the conversation list first pick of a column overflow,
since the list's flex basis is far larger. That claim is wrong, and it is why
the row in the screenshot was clipped.

Flexbox shrinks every child in proportion to its own flex basis, at the same
time, not one child before another. With a 120px shelf and a 1600px list, the
shelf still gave up about 7% of the overflow. The 95-3 probe ran with two
conversations, so the overflow was small and the shelf lost almost nothing.
With nine or more conversations the list's basis spans many screens, the
overflow tops a screen, and 7% of it was half the row.

With shrink at 0, the shelf holds its content size up to its existing 40vh
cap and scrolls past that cap (`.chalk-zucker-rows` already sets
`overflow-y: auto`). The conversation list takes whatever height is left. The
95-3 comment in `theme.css` and the matching paragraph in
[PHASE-95-PHONEVOICE.md](PHASE-95-PHONEVOICE.md#95-3--the-shelf-was-being-squeezed)
carry a correction note pointing back here. Neither section was otherwise
rewritten.

### 126-2 — the call bar

`VoiceDock.tsx` mounts once, inside the sidebar. It owns the hidden `<audio>`
sinks for every peer, the boost graph, the pop-out cleanup, and the
autoplay-resume handler. Zuckermode hides the sidebar — it is a fixed drawer
translated off-screen, and the nav toggle is `display: none` — so the dock's
bar and leave button are unreachable there.

Moving the dock itself into the footer under `zuckerActive` remounts it on
every layout flip: a phone rotated to landscape crosses the 767px mobile
breakpoint, and a remount recreates the audio sinks mid-call. So the dock
stays where it is and keeps doing audio, and a new component,
`web/src/components/ZuckerCallBar.tsx`, reads the same session snapshot
(`useVoiceSession`, exported from `VoiceDock.tsx`) to show a bar of its own.

`ZuckerCallBar` renders nothing while `snap.phase === "idle"`. Otherwise, one
row: the room glyph and name as a button (jumps back to the room — App's
`onJumpToChannel` sets the active channel, refreshes unread for the room, and
switches the zucker screen to "chat"), a "▸" hint shown only when the active
channel is not the connected room, the running duration or "joining…" before
the call connects, the live dot while the microphone is open and not muted,
and a leave button. Above the row, the same "tap anywhere to enable audio"
nudge the dock shows, needed here because the dock's own copy sits inside the
hidden drawer.

Going back to the list only switches the zucker screen. The active channel
still holds the room, so the bar first read that as "you are looking at the
room" while you stood on the list, and the "▸" hint never showed there. App
passes `activeChannelID={zuckerScreen === "list" ? null : state.activeChannelID}`,
where null means no channel is on screen, so the hint shows correctly on the
list screen.

The bar reuses the dock's `.chalk-voice-dock` classes so it reads as the same
control. `.chalk-zucker-callbar` zeroes the dock's sidebar margin, sized for
a column and wrong for a footer flush against the screen edge.
`.chalk-zucker-callbar-hint` styles the arrow. The one-second ticker matches
the dock's, for the same reason: the running duration.

`App.tsx` renders the bar inside `<footer class="chalk-footer">`, after the
main composer area, only when `zuckerActive`. The mobile footer stacks in
`column-reverse`, so the bar, being last in the markup, sits at the top of
the stack: above the composer on the chat screen, and above the voice
controls band on the list screen, where the composer is hidden. The bar
shows on both screens, including the room's own screen, since the call panel
there carries no leave button — 44-2 moved mute and deafen to the global
controls and left leave to the dock.

`fmtDuration` moved from `VoiceDock.tsx` to a new file,
`web/src/voice/duration.ts`, unchanged, so the bar can share it and so it can
be tested in Node without pulling in the session, pip and boost modules
behind `VoiceDock.tsx`.

## Verification

`.claude/skills/run-chalk/probes/ui.mjs` ran 16 checks under iPhone 14
emulation (390x664) with a fake microphone: two users, ten text channels and
one voice room, one user in Zuckermode. All 16 checks passed on 2026-09-13.

With ten conversations below it, the open voice shelf measured `scrollHeight`
56 against `clientHeight` 56 — equal, so nothing was clipped — and the room
row sat at 237-293 inside the shelf's own 237-294, with the conversation
list still 309px tall. Before 126-1 the same setup clipped the row, matching
the reported screenshot.

On the room's own screen the bar measured 427-469 of the 664px viewport,
between the call panel and the composer. On the list screen the bar stayed,
showed the "▸" hint, sat at 526-568 directly above the controls band at
576-656, and its clock advanced from 00:01 to 00:03 over the check. Tapping
the room name returned to the room. Tapping leave removed the bar and stood
the controls band down. No page errors.

This is Chromium emulation, not iOS Safari, so the manual checklist below
still stands for a real device.

Two things worth keeping for whoever rewrites the probe: the what's-new note
and the picture-ask nudge each place a backdrop over the app, and the
what's-new note returns after a reload. `CHALK_DEV_SKIP_NPM=1` skips the
entire web build in `tools/dev.sh`, so a probe run against a stale bundle can
pass against the previous build.

## Not done

- The room you are in is still just a row in the collapsed shelf, 95's last
  open item on this point. The bar now names the room you are in, so this is
  lower priority than it was.
- Nothing shows who is in a room before you tap it, short of opening the
  shelf. Tapping a room still joins it (30-5's auto-join).
- The classic mobile drawer is unchanged. Its dock stays reachable through
  the drawer, as before.

## Rejected

- Moving `VoiceDock` into the footer under `zuckerActive` — the remount on a
  layout flip, above.
- Splitting `VoiceDock` into an audio half and a bar half. Right in the long
  run, but a refactor of a component that owns live audio is a large change
  for a one-row phone bar.
- A leave button inside `VoiceControls`, 95's own suggestion for this gap. It
  gives a way out but no way back to the room from the list, and no room
  name.
- A voice subpage with an explicit join step and a half-screen call view.
  Discussed and rejected in favor of the bar: a half-screen view leaves no
  room for tiles once the on-screen keyboard is open.

## Manual checklist

- [ ] iPhone Safari, Zuckermode, ten or more conversations. Open `@ voice`.
      The room row shows whole, not clipped.
- [ ] Tap a room. The bar shows with the room name and a running duration.
- [ ] Tap back to the conversation list. The bar stays and shows the "▸"
      hint.
- [ ] Tap the room name in the bar. You return to the room.
- [ ] Tap leave. The bar disappears and the voice controls band hides.
- [ ] Android Chrome, the same five steps.

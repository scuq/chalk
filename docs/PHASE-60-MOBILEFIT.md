# Phase 60 — the 16px control floor and the pinned room header

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.4.10.
**Tags:** `#mobile`, `#presence` → `tools/where.sh -g mobile`

## Why

Two unrelated irritations, both about chalk on a phone being technically usable
and practically not:

- **iOS auto-zoom.** Safari zooms any input rendered below 16px and never zooms
  back out. Tapping the message box, the sign-in form, the channel-create dialog
  or a search field left the whole page stuck zoomed in. The fix is a **floor,
  not a per-field patch** — every control on a phone renders at 16px — plus
  `text-size-adjust` so rotating to landscape does not inflate text
  unpredictably. It took three attempts to land a rule that actually won the
  cascade.
- **No room name while reading.** The channel/DM title lived at the top of the
  message history and scrolled away with it, so mid-conversation there was
  nothing on screen saying which room you were in. It is now pinned above the
  feed, with a long name ellipsised rather than wrapping the bar over several
  lines.

60-1 is separate: chalk visible but not focused waited 5 minutes before marking
you away, which is short for "working next to a chalk window".

## What landed

- **60-1** — raise the unfocused auto-away timeout from 5 to 10 minutes.
- **60-2** — 16px control floor across every input; pinned room header above the
  feed; thumb-sized reaction targets in the quick-react row and the emoji
  picker.

## Where it lives

`web/src/theme.css` (the mobile block and the control floor),
`web/src/components/MessageList.tsx`, `web/src/components/App.tsx`,
`web/src/presence/` for the away window.

## Notes

The desktop side of the pinned header — and the opaque strip under it that
stopped a clipped line of text showing through the gap — is 69-2.

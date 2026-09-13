# Phase 124 — settings dialogs read as rows, not a run of text

**Status:** 124-1 – 124-3 built (2026-09-13). Verified against a running
stack: a Playwright probe drove the real UI, 39 of 39 checks across five
themes (green, light, lcars, catppuccin-latte, solarized-dark) at 1280px and
400px, covering all five profile tabs and all three voice tabs, the switch
still toggling, the focus ring, the settings filter, and no sideways
overflow. 41 screenshots.

**Tags:** `#settings` → `tools/where.sh -g settings`

## The problem

`.chalk-profile-field`, the wrapper around one setting (50 uses in
`ProfilePanel.tsx`, 14 in `MicSettings.tsx`), carried no CSS rule.
`.chalk-profile-label` carried none either. A row's only separation came
from the browser's default bottom margin under a `<p class="chalk-profile-
hint">`, since the stylesheet has no `<p>` reset, and `.chalk-modal-body`'s
flex gap does not reach inside a `<section>`, which is not a flex
container. Each option's description sat inline in parentheses inside the
label itself, at the same size and in the same flow as the label text,
under a class built for the theme picker
(`.chalk-profile-theme-desc`). Open the profile panel or the voice and
video dialog and every setting read as one undifferentiated run of text,
with no way to tell where one option ended and the next began.

## The design

Three decisions, taken with scuq.

**Each `<section>` becomes a group card.** A background of
`--chalk-bg-elev` and a 1px `--chalk-border` around each settings section
turns the tab's content into labelled cards instead of a bare column of
controls.

**Each `.chalk-profile-field` becomes a row.** Label and its description
on the left, control pinned to the right edge, a hairline between rows. A
row stacks its children in a column by default — this covers ranges,
pickers, sound lists, the mic meter and button rows with no rule of their
own. Only a row built around a `<select>` grids into two columns instead,
because a trailing hint under the control has to span both columns
beneath it, which a flex row cannot do without an extra wrapping element.
The hairline between two rows uses the `~` sibling combinator rather than
`+`, because `MicSettings` puts a plain `<p>` between two fields (the
"press test and talk normally" paragraph under the level meter), and `+`
would let that paragraph swallow the hairline meant for the row after it.

**Checkboxes are drawn as switches, in CSS only.** The element stays an
`<input type="checkbox">`, so every `data-testid`, keyboard path and
existing test keeps working unchanged. `order: 1` on the input, with
`justify-content: space-between` on the label that wraps it, moves the
switch to the right edge without reordering any JSX — which is also why
the four checkbox labels with no wrapping `<span>` around their text still
read correctly. The unchecked track uses `--chalk-fg-muted` rather than
`--chalk-border`, because on the dark themes the card fill and the border
token sit too close together and an off switch had no visible outline. On
LCARS, where `--chalk-radius` is 10px, the same token turns the track and
its knob into a pill with no rule of its own — a property of deriving
both from one token. `prefers-reduced-motion: reduce` turns off both
switch transitions.

Descriptions moved out of the label's parentheses to their own line under
the label, in a new class, `.chalk-profile-desc`. It shares one rule with
`.chalk-profile-hint` inside these dialogs — dim, small, upright — because
position already tells the two apart: what the option is, under the
label, and what to know, under the control. Italic 12px monospace,
`.chalk-profile-hint`'s usual style outside this scope, is the least
legible text in the app on several themes.

Three fills that had read fine on the plain background dissolved once
their element sat on a card, and each got a scoped, still token-derived
override. The active theme swatch and the camera button's hover move up a
step to `--chalk-bg-elev-2` so they still show against the card, and a text
field drops to `--chalk-bg` so it reads sunken into the card rather than
flush with it. The notification sound list's row gives its checkbox label
`display: contents`, dropping the label's own box so its "play" button
sibling can join the same flex line as the switch — name and description,
then play, then switch — while the label stays in the DOM and keeps
pairing the checkbox with its text.

`solarized-dark` declares `--chalk-border` the same colour as its own
`--chalk-bg-elev`, so every card border and row hairline from this phase
would have been invisible on it. A scoped override re-points the token to
`--chalk-bg-elev-2`, inside the settings dialogs only, rather than
changing the token for the theme as a whole, which would move every other
border in it too.

Every selector in this phase is scoped under `.chalk-modal--settings`,
which only the profile panel and the voice and video dialog carry.
`NotificationsPanel` reuses `.chalk-profile-hint`, `.chalk-profile-sound-
list` and `.chalk-profile-theme-desc`, and so do `WhatsNewNudge` and
`AvatarNudge`, but none of the three carry `.chalk-modal--settings`, so
they keep the earlier look. Without the scope this restyle would have
reached all three uninvited.

## What was rejected

**An unscoped restyle**, applying the new row and card rules to
`.chalk-profile-field` and `.chalk-profile-label` everywhere. Rejected,
because `NotificationsPanel`, `WhatsNewNudge` and `AvatarNudge` reuse the
same class names and were not part of the request.

**A flex row for the select variant.** Rejected, because a trailing hint
under a `<select>` has to span the full row width beneath the control, and
a flex row cannot do that without an extra wrapper around the hint.

**Reordering the JSX to put each switch after its label text.** Rejected
in favor of `order` and `justify-content` in CSS alone, which reaches the
same layout without touching component markup that some checkbox labels
already relied on holding bare text with no wrapping `<span>`.

**A dedicated switch component, replacing the checkbox.** Rejected,
because every `data-testid`, keyboard interaction and test already
written against `<input type="checkbox">` would have to move with it, for
a change that is visual only.

## The slices

- **124-1 — group cards, rows and switches.** The `theme.css` block scoped
  under `.chalk-modal--settings`: bordered section cards, the row layout
  for `.chalk-profile-field` with its stacked default and its select-row
  grid, the CSS-only switch, the shared `.chalk-profile-desc` /
  `.chalk-profile-hint` styling, and the `solarized-dark` border-token
  override.
- **124-2 — the components move onto the new rows.** `ProfilePanel.tsx`
  and `MicSettings.tsx`: descriptions taken out of the label's parentheses
  and given their own `.chalk-profile-desc` line, the link-previews
  section split so its two switches and its domain editor each sit in
  their own `.chalk-profile-field`, and the two profile-panel buttons that
  open the voice and video dialog and clear the image cache switch from a
  one-off class to the shared `.chalk-button`.
- **124-3 — touch sizing on mobile.** Inside the existing
  `max-width: 767px` block: rows get extra vertical padding, and the
  switch grows from 30x16 to 36x20 with the knob's travel widened to
  16px, both sized for a touch target rather than a pointer. A select
  field drops its two-column layout and returns to full width under its
  label, since the label's 45% minimum left too little room for a long
  value and clipped it mid-word.

## Left open

- **Four themes were not eyeballed individually.** `tokyo-night`,
  `darkord`, `exchalk` and `catppuccin-mocha` all declare `--chalk-border`
  one step above their own card fill, so a card border and a row hairline
  are present by measurement, not by inspection.
- **`.chalk-profile-theme-desc` still exists**, and is still the correct
  class for the theme and font pickers, for the two decibel readouts on
  the voice threshold row, and for the server commit hash in the about
  section. It is no longer used for a row's description.
- **The passkey list still carries inline `marginTop` styles**, rather
  than rules in the stylesheet.

## Manual checklist

- [ ] `tokyo-night`, `darkord`, `exchalk` and `catppuccin-mocha`: open the
      profile panel and the voice and video dialog, and check that the
      card border and the row hairline are visible, not just present in
      the computed style.

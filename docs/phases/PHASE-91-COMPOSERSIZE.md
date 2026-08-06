# Phase 91 — resizing the message box

**Status:** 91-1 shipped. One slice; the phase is closed unless the follow-ups
under [Left open](#left-open) are taken up.

**Tag:** `#composer` → `tools/where.sh -g composer`.

## The problem

The composer has always been resizable, and almost nobody would find out. The
only affordance is the browser's own corner grip on the textarea — a ~12px
triangle in the bottom-right of the field, drawn by the engine, absent
entirely on Firefox for some styling combinations and on every touch device.
Two things follow:

- **It is not discoverable.** Nothing about the field says it can be dragged;
  the grip is a rendering detail people learn from other apps or never.
- **It is not remembered.** The grip writes an inline `height` on the element.
  Reload the page and the field is two rows again — on a client whose entire
  layout state (sidebar width, tool style, timestamps) is an account-synced
  pref, this is the one piece of chrome that forgets.

Meanwhile the line above the composer — the footer's `border-top` — is the
one element on the screen that already means "boundary between what you are
reading and what you are writing", and every IDE, mail client and terminal
multiplexer has taught people to drag exactly that.

## The design

Put a drag handle on that line, and make what it sets a pref.

This is the sidebar resizer (33-4) turned through 90 degrees, and it is built
that way deliberately: `SidebarResizer` and `ComposerResizer` are the same
component with an axis swapped, the same "parent owns the live value, prefs
see one write per gesture" split, and the same invisible-until-hover 8px grab
strip straddling the border it resizes. A reader who has understood one has
understood the other.

- **Drag up for a taller field**, down for shorter. Arrow keys nudge by 16px,
  `Home` and double-click reset.
- **The value is `chat.composerHeight`**, so it follows the user to their
  other devices like every other chat pref.
- **Desktop only.** On mobile the footer stacks (`column-reverse`) and there
  is no divider to aim at with a finger; the handle is not rendered and the
  pref is not applied.

### Auto is 0, and 0 is the default

The stored height is px, with **0 meaning "no explicit height"** — the two
rows the field has always been. That is the default and what a reset returns
to. It is a sentinel rather than a number because the alternative is worse:
a px default would be correct at exactly one UI scale, and chalk's font size
is itself a pref. "Two rows at whatever size you read at" is the thing being
restored, and only the absence of a height expresses it.

### Both grips, one field

The corner grip stays. It writes an inline `height`, which outranks the
custom property the pref drives — so the two mechanisms have to agree about
who is in charge, and the rule is that the handle takes over:

- A gesture **starts from the height on screen**, measured, not from the
  stored pref. Drag the divider after a corner-grip resize and it continues
  from where the grip left off instead of jumping back.
- The first pointer-move **clears the inline height**, handing control to the
  pref. Deliberately on the move rather than on pointer-down: a click that
  never moves would otherwise flash the field back to its default and out
  again.

So the grip is the ad-hoc nudge that nothing remembers (exactly as before),
and the divider is the one that persists.

### Two ceilings, on purpose

`.chalk-composer-input`'s `max-height` was a flat `30dvh`. The handle can go
past that — someone dragging a divider upward means it — but not without
limit, so the rule became:

```css
max-height: clamp(30dvh, var(--chalk-composer-h, 30dvh), 60dvh);
```

Unset (the thread composer, mobile, an untouched pref) that is the old
`30dvh` exactly. Set, it is the dragged height, capped at 60dvh — below that
the feed above stops being worth reading.

`composerHeightCeiling()` repeats the 60dvh cap in JS, and both are needed:
the CSS one stops a pref written on a tall monitor from eating a laptop
screen, the JS one stops the divider running away from a pointer the CSS has
already halted.

### The custom property rides on the footer

`--chalk-composer-h` is set inline on `<footer class="chalk-footer">`, not on
the app shell where `--chalk-sidebar-w` lives. Custom properties inherit, and
the thread panel's reply composer uses the same `.chalk-composer-input`
class — scoping the variable to the footer is what keeps the thread field its
own size without a second class or an override.

## Slices

| slice | what it lands |
| --- | --- |
| 91-1 | `chat/composer-height.ts` (bounds, clamps, the auto sentinel), `ComposerResizer.tsx`, the `chat.composerHeight` pref through `selectChatPrefs`, App wiring, the handle's CSS and the `clamp()` max-height. Covered by `chat/composer-height.test.ts` (10 tests) and a 16-check browser probe. |

## Verified

`node test.mjs` 1217/0. The DOM half cannot live there, so it was a
`probes/ui.mjs` run against the dev stack — 16/16, including: the drag grows
the field and the feed gives up exactly that space, the height rides the pref
var with no inline style, it survives a reload (so it reached the server),
a runaway drag stops at 60dvh, double-click and `Home` return to the default,
the corner grip still works and a drag continues from where it left off, and
no handle appears under iPhone emulation.

## Left open

- **No settings-panel control.** The sidebar width has a slider in
  profile → display; this has only the handle. Worth adding if anyone asks
  for a keyboard-only path better than focusing the separator.
- **The grip is still unremembered.** A corner-grip resize that is never
  followed by a divider drag is lost on reload, as it always was. Persisting
  it would take a `ResizeObserver` on the textarea, which is a lot of
  machinery for a gesture that now has a discoverable alternative.

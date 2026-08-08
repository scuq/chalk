# Phase 94 — the phone composer

**Status:** 94-1, 94-2 and 94-3 shipped together. One change set; the phase is
closed unless the follow-ups under [Left open](#left-open) are taken up.

**Tag:** `#composer` → `tools/where.sh -g composer`. (Shares the tag with 91 —
both are about the shape of the box you type into.)

## The problem

The composer was designed on a desktop and then dropped onto a phone, where
all three of its parts read differently:

- **The tool rail eats the field.** `FILE` `GIF` `EMOJI` `CODE` in a 2×2 grid
  is a 110px block. On a 390px screen that is nearly a third of the composer's
  width spent on four labels, next to a field that then fits about twenty
  characters per line.
- **The send button is a 26px chip in the corner.** On a desktop that is
  deliberate (42-1: Enter sends, the button is for the mouse and should not
  shout). On a phone the button is not the fallback — it is the *only* way to
  send, and it was the smallest thing in the footer.
- **Enter sends.** The on-screen keyboard's return key has no Shift beside it
  to pair with, so the desktop's "Enter sends, Shift+Enter breaks the line"
  collapses into "you cannot type a second line, and a stray return posts a
  half-written message". Every phone chat client resolves this the same way,
  and chalk was the odd one out.

While measuring the first two, a fourth thing turned up that nobody had seen
because it hid under the right edge of the screen — see
[the overflow](#the-overflow-that-was-already-there).

## The design

Three slices, one change set, all keyed off the existing `useIsMobile()`
media query (`max-width: 767px`) rather than a new signal — the composer's own
mobile CSS already keys off exactly that, and one breakpoint that disagrees
with itself is worse than a slightly blunt one.

### 94-1 — initials instead of words

The text tool style renders `F` `G` `E` `C` below the breakpoint. `TOOL_LABELS`
in `Composer.tsx` holds both readings; `title` and `aria-label` are untouched,
so a screen reader and a long-press still say "attach a file". The buttons
become the same 34px squares the icon style already uses on a phone, which
takes the rail from ~110px to 72px and hands the difference to the field.

Initials rather than switching the phone to the icon style: the style is an
account-synced pref (`chat.composerToolStyle`), and silently overriding a
setting on one device is how a preference stops being believed. Someone who
picked words gets words, abbreviated.

### 94-2 — the send button is the field's height

`align-self: stretch` instead of a fixed 26px/34px height, on both layouts.
The row's height is the textarea's, whether that is the default two rows or a
height dragged out by the 91-1 handle, so the button follows it for free.

This reverses 42-1's "small button parked in the corner", and on purpose: with
the field resizable and Enter no longer sending on a phone, the button is a
target people aim at rather than a curiosity beside the shortcut they actually
use. It stays an outline button — the change is its size, not its volume.

### 94-3 — Enter is a newline on a phone

`onKeyDown` skips the send branch below the breakpoint, so the key does what
the textarea would do anyway. The send button is the only send path there.

Two things deliberately unchanged: the @mention popup still accepts on Enter
(it is completing a token, not posting), and an IME's committing Enter is
still swallowed by the 48-2 guard ahead of it.

The shortcut sheet in settings (76-1) was the only written record of "enter →
send", so `composerHelp()` takes a `mobile` flag and reads "new line — tap
send to send" there, dropping the `shift+enter` row that has nothing to say on
a phone. The ctrl/⌘ rows stay: a phone can have a keyboard attached.

## The overflow that was already there

Measuring 94-2 in a browser turned up a bug older than this phase: on a 390px
viewport the composer row was **393px wide**, hanging the send button off the
right edge and giving the whole page a horizontal scroll. Two causes, both in
the footer, and neither visible in any unit test because both are layout:

1. **`.chalk-footer` is a grid item with the default `min-width: auto`,** so
   its automatic minimum is its min-content width. A textarea's min-content is
   the intrinsic width of its `cols` — about 230px — which no amount of flex
   shrinking *inside* the row can get under. That inflated the `1fr` track
   past the screen.
2. **The mobile footer flips to `flex-direction: column-reverse` and inherits
   the desktop's `align-items: end`.** In a column flex that no longer means
   "sit on the bottom of the grid row"; it means "hug the right edge", so the
   composer stopped stretching to the footer's width and took its own
   min-content width instead — overflowing to the *left*, which is why the
   rail's first button was clipped rather than the send button.

`min-width: 0` on the footer and `align-items: stretch` on its mobile rule fix
each half. The wider send button made the symptom about 8px worse, which is
how it got noticed at all.

## Verification

`.claude/skills/run-chalk/probes/ui.mjs` (the scratch probe slot — rewritten
per investigation, so this is a description, not a promise it still exists):
registers two users, makes a channel, and measures the real layout at 1280×720
and 390×844. Twelve checks — labels per layout, rail width, send height against
field height on both layouts and after the field grows, Enter sends on the
desktop, Enter types a newline and sends nothing on the phone, the send button
still sends there, and the row fits inside the viewport.

The pure half lives in `web/src/chat/composer-keys.test.ts`: the phone reading
of the shortcut sheet.

## Left open

- **The tool style's setting label still says `text (FILE, GIF, EMOJI)`.**
  True on the device the labels are read on most; a phone-aware label would be
  a settings-copy change for a pref that is account-wide.
- **Nothing tells a phone user that Enter no longer sends.** It matches every
  other chat app, so it should need no announcement, but there is no hint in
  the composer either.
- **The breakpoint, not the keyboard, decides.** A tablet at ≤767px with a
  hardware keyboard loses Enter-to-send. Detecting a real keyboard is not
  something the platform offers, and a pref for it would be a setting nobody
  finds; if this ever bites, the fix is the pref.

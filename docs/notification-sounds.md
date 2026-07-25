# Notification Sounds

Built in phase 40. Client-side only; the server knows nothing about any of
this.

## Sound design

The app is called chalk, so every sound is a **chalk stroke on a board** — the
warm, big-piece-of-chalk kind, never the screech. That is not an oscillator: a
bell is a pitched tone that gets struck and decays, chalk is friction, which
means broadband noise shaped by what you take out of it.

```
  bell / chime          chalk stroke
  |\____                 __---____
  struck, decays         contact, drag, lift
```

Four parameters carry the whole design, in `web/src/notify/synth.ts`:

| | |
|---|---|
| `lowpassHz` | The anti-screech ceiling. Nails-on-a-blackboard is stick-slip resonance at roughly 2–8 kHz, so nothing here goes near it. If a sound ever turns sharp, this is the knob. Enforced against `SCREECH_FLOOR_HZ` by the tests, at both ends of the sweep. |
| `q` | Bandpass width. Narrow bands make noise ring at their centre and the stroke becomes a beep; everything stays wide. Capped at `MAX_Q`. |
| `sweep` | How far the band travels while the stroke sounds. The movement is what makes it a swish rather than a hiss — a sweep of 1 is a bug. |
| `body` | A quieter layer an octave down, following the same sweep. This is how big the piece of chalk is. |

There are **no oscillators anywhere in the pack**. An early version put a quiet
sine under the noise so each category had a nameable pitch; it made everything
peep. Categories are told apart by brightness, length, sweep direction and
stroke count instead.

Two-tone categories are two separate strokes, not a glide. Direction carries
meaning: **rising = something arrived for you, falling = something went wrong.**

`disconnect` deliberately breaks the pattern — it is an eraser sweep, the
widest, dullest, longest and heaviest thing in the pack. Losing the connection
should sound like the board being wiped, and the tests hold it to that.

The numbers in `SOUND_SPECS` were tuned by ear. Treat the table as a recording
of that session rather than as arithmetic: changing one means listening again.

## Categories

| Category | Default | Fires on |
|---|---|---|
| `mention` | on | someone writes your handle in a channel |
| `dm` | on | any message in a 1:1 |
| `thread_reply` | on | a reply in a thread you wrote in |
| `message` | on | any other new message |
| `presence` | off | a friend goes from away/offline to online |
| `connect` / `disconnect` | off | your own connection |
| `send_confirm` | off | the server acked your send |
| `error` | on | a server error frame |

Exactly one sound per arriving message: the four chat categories are a
precedence order, resolved in `web/src/notify/classify.ts`. A DM outranks a
mention, because in a 1:1 the channel already tells you the message is for you.

## Suppression rules

In `web/src/notify/gate.ts`, applied in this order, and every one of them is
reported as a named verdict rather than a bare boolean so a "my sounds randomly
don't fire" report is answerable.

1. Master switch off, or this category off
2. Tab focused **and** the relevant channel already open → no sound
3. Do not disturb → no sounds at all
4. Under 2 s since any sound, or under 5 s since this category → no sound
5. Audio not yet unlocked → drop, never queue

Rule 2 applies to `connect`/`disconnect`/`error` too: if the window is in front
of you, the status bar has already said it.

Two more guards live at the call sites in `App.tsx` because they need app state:
your own messages never sound (they come back to you on your other devices and
after a reconnect), and only live pushes sound — the history backfill that runs
on reload calls the same classifier and would otherwise play the entire backlog
at once.

## Unlocking

An `AudioContext` is born suspended and only resumes from inside a real user
gesture, so the first click or keypress anywhere unlocks sound for the session.
Before that the gate returns `locked` and nothing is queued — a message that
arrives before you have touched the page is silent, not saved up. No context is
created until then either.

This is also why sounds can default to on without startling anyone: a tab left
open and never touched cannot make a noise.

## Settings

Per-device, in `localStorage` under `chalk.notify.v1` — **not** the server-synced
prefs blob that carries the theme. Two reasons: `user_preferences` is plaintext
JSONB the server reads, so keeping sounds local is the only way to honour "the
server never sees your sound preferences"; and volume is a property of the
machine, the same argument `display-prefs.ts` makes for fonts.

```js
{ master: true, volume: 0.4, dnd: false, categories: { mention: true, ... } }
```

The profile panel's notifications section is the UI, with a preview button per
category. Writes notify same-tab listeners as well as firing the cross-tab
`storage` event, so a toggle takes effect immediately in every tab without a
reload.

## Not built

- **`dnd_schedule`** — a time-window scheduler. The `dnd` boolean exists; the
  schedule is its own slice.
- **A sample-based pack.** `pack: "synth"` is not stored either: there is one
  pack, and a discriminator with one value discriminates nothing. Both return
  together.
- **OS-level notifications.** The category model and suppression rules would
  carry over unchanged. Permission would be requested only when the user
  explicitly enables them, never on load.
- **`error` on decryption failure.** It fires on server error frames only.
  Detecting a failed decrypt means string-matching the fail-closed placeholder
  body, which is too fragile to build on.

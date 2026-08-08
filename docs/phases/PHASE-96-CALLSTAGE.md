# Phase 96 — the call's layout, and the share's own volume

**Status:** 96-1, 96-2 and 96-3 shipped.

**Tag:** `#voice` → `tools/where.sh -g voice`.

## The problem

Three things, all found by being in a call rather than by reading the code.
All three are local, view-side decisions — nothing here touches the wire, the
roster, or what anyone else sees or hears.

**The grid would not appear.** 63-1 switches the stage from the spotlight (one
big tile, the rest in a strip) to a grid of equal tiles at three participants,
*unless* a tile is pinned. But in a 1:1 call the spotlight is the only layout
there is, so clicking a face there means "look at this one", not "do not use
the grid" — and yet the pin it left behind was still in force when a third
person joined, and the grid never came up. The only way back was to find and
click the big tile.

**The layout was a rule with no override.** Even working correctly, the rule is
a guess. Two people who want equal tiles cannot have them; three people with a
terminal on screen are forced into the spotlight by the share and cannot see
each other's faces at equal size.

**One volume drove two sounds.** 30-7b deliberately hung the shared program
audio (the tab or system sound riding a screen share) off the *person's*
`peerAudio` row, reasoning that muting someone should mute their game with
them. In practice the thing everyone reaches for is the opposite: turn the game
down so you can hear the person talking over it. With one slider that is not
expressible — pulling A's volume down took A's voice with it.

## The design

### The layout is a standing choice, defaulting to the rule

`voice/grid.ts` grows `VoiceLayout = "auto" | "grid" | "spotlight"` and
`resolveGridMode(layout, tileCount, hasLiveShare)`. `"auto"` is the 63-1 rule
unchanged; the other two are what the viewer asked for and outrank everything,
so a forced grid keeps its tiles through a screen share and a forced spotlight
keeps its big tile in a room of nine.

`resolveGridMode` **does not consult the pinned tile**, and that is the fix for
the first problem. Leaving the grid is now a layout decision recorded where it
is expressed: clicking a *grid* tile pins it and sets `"spotlight"`; clicking a
tile in the strip only re-points the existing spotlight and says nothing about
the layout. A pin made at two participants therefore cannot speak for a stage
that has since become a group call.

Clicking the big tile releases the pin and returns to `"auto"` — the 63-1
affordance, kept. It is a no-op when there is no pin, so a spotlight chosen
deliberately with the toggle is not undone by a click on the tile it is
showing.

Both the pin and the layout reset when the panel changes room or the call ends.
They describe this stage, not the account: nothing is persisted and nothing is
synced. That is a deliberate difference from the audio prefs below, which are
about a *person* and do follow you.

### The toggle sits in the control bar

One button, labelled `tiles`, lit while the grid is what you are looking at
(by rule or by choice) — the same shape as `debug` and the transport knobs
beside it, rather than a second pair of mode buttons like the share-mode row.
It appears once there are at least two tiles; below that there is nothing to
arrange.

Switching *to* the grid drops the pin. A pinned tile inside a grid of equals is
a promise the layout cannot keep, and leaving it set would have it resurface
unbidden the next time the spotlight came up.

### The share's audio gets its own pair of controls

`PeerAudioPref` grows `screenMuted` and `screenVolume` beside `muted` and
`volume`; `VoiceDock`'s screen sink reads the new pair, and the screen tile
carries a mute button and (on the big tile, where there is width — same rule as
the camera tile) a slider. Deafen still takes everything: that control means
silence.

Only a share that actually carries an audio track gets the controls. Most
shares carry none, and a dead slider is a lie. `hasAudio` is recomputed with
the rest of the stage on the one-second tick, so a track added mid-share
appears.

Storage and sync are unchanged in shape: same per-channel, per-user row, same
encrypted blob, same `VERSION = 1`. The normalizer is total and the new fields
default to "share at full volume", which is exactly what a row written before
this phase meant. The one wrinkle worth knowing: a device running an older
build opens a new blob, drops the two fields it does not know, and writes the
stripped row back on its next edit — last-write-wins already works that way for
this list, and the loss is two numbers about one person in one room.

### What was rejected

- **Making the pin layout-aware in the panel** (remember the tile count at pin
  time, expire the pin when it changes). It fixes the symptom, is untestable
  without a DOM, and leaves the layout still unswitchable.
- **A three-state button** (`auto / tiles / spotlight`). The `auto` state is
  invisible in the UI — it looks like whichever of the two the rule picked —
  so a third position users cannot see the effect of buys nothing. `auto` is
  reachable by clicking the big tile, and by leaving the room.
- **Persisting the layout per channel.** It is a decision about a moment (who
  is talking, what is on screen), not about a room.
- **Keeping "mute for me" as a master over the share.** Then the split is only
  half a split, and the case that prompted it — hear the person, not the game —
  still needs two controls to express. The two are independent; the tile shows
  a local-mute `M` flag for each.

## The slices

- **96-1 — the layout resolves without the pin.** `resolveGridMode` +
  `VoiceLayout` in `voice/grid.ts`, the `layout` state in `VoiceCallPanel`, and
  the pin/unpin handlers that record intent. Fixes the grid that would not
  appear.
- **96-2 — the toggle.** The `tiles` button in the control bar, beside `debug`.
- **96-3 — the share's own volume.** `screenMuted` / `screenVolume` through the
  store, the normalizer, the session setters, the dock's screen sink and the
  screen tile's controls.

## Manual checklist

`resolveGridMode` is unit-tested (`voice/grid.test.ts`) and the prefs are
covered by `peer-audio-sync.test.ts`, but the wiring needs a real call and two
browsers:

- [ ] Two participants, click a face, third joins → the grid appears.
- [ ] In the grid, click a tile → spotlight on that tile; click the big tile →
      back to the grid.
- [ ] `tiles` lights and unlights, holds through a share starting and stopping,
      and is gone from the bar in a solo room.
- [ ] Share a tab **with audio** from A. On B: the share tile has `mute sound`;
      pull A's voice slider to zero and the tab audio keeps playing; mute the
      share and A is still audible. Deafen silences both.
- [ ] Both settings survive a rejoin of the same room, and reach a second
      device (the encrypted prefs blob).

## Left open

- The share's slider, like the camera tile's, is on the **big tile only** — a
  grid tile is too narrow for a range input beside two buttons. Pin the share
  to adjust it. Same limitation 30-7b/66-4 left for the voice slider.
- Hiding a share (`hide for me`) still leaves its sound playing. Arguably
  hiding should imply muting, but the two controls now sit next to each other
  and either is one click, so tying them would remove a combination someone
  wants (listen to the stream, watch the faces) to save a click.
- Nothing here is on the phone's voice screen (95-2), which has neither the
  control bar nor the tile labels.

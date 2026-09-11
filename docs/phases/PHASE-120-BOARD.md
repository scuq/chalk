# Phase 120 — the board: the whole call in one window, tiles arranged by hand

**Status:** built, 120-1 – 120-2 (2026-09-12); 120-1 shipped in v0.8.20. Unit-tested (`web/src/voice/board.test.ts`:
the grid, the window's contents, sync, drag bounds and raise, the honest
failures, the on-top pref). Not yet used in a real call — the checklist below.
**Tags:** `#voice` → `tools/where.sh -g voice`

## The problem

scuq asked for a "pop out all": one window with every participant tiled,
where the tiles can be dragged and resized as the person likes. 45-5 and
47-4 pop a single tile out into a window of its own, which is the shape for
"the shared screen on my second monitor"; it is not the shape for "the
whole call over there, arranged my way" — four windows to place by hand,
none of them aware of the others.

## The design

### 120-1 — one window, a grid to start, then yours

- **`web/src/voice/board.ts`** owns the window, the way `pip.ts` owns the
  per-tile ones. `openBoard(tiles, host, {onTop})`, `syncBoard(tiles)`,
  `closeBoard()`, `boardOpen()`, `subscribeBoard()`. One board at a time; a
  second open raises and resyncs it.
- **Same mechanics as pip.ts.** A plain `window.open` pop-up (or, with
  118's "above other windows" pref on and the floating window unclaimed,
  document PiP). An about:blank pop-up is same-origin, so the elements and
  their listeners are created by the opener's script and simply live over
  there. Styling is property assignment on `element.style`, never an
  injected `<style>` — the pop-up inherits the opener's CSP, and style-src
  'self' refuses an inline stylesheet (pip.ts's lesson).
- **The grid** (`boardLayout`, pure): the tightest grid that holds n tiles,
  each 16:9 plus a 22px name strip, centred in its cell. The window is 80%
  of the screen, capped at 1280×800 — the tiles are resizable, the window
  is the browser's to resize.
- **Drag** by the name strip, with pointer capture so a fast drag does not
  escape it; a tile cannot leave the board (its strip stays reachable),
  because one dragged fully off could never be dragged back. **Resize** is
  the browser's own `resize: both` on the tile, no code, every engine; the
  video fills whatever size the corner is dragged to. A tile you touch
  comes to the front.
- **Sync** follows the call the way `syncTilePopouts` does: gone tiles
  leave, new ones arrive cascaded (the grid was the person's to rearrange
  and is not re-imposed), a swapped stream is followed, a changed label is
  rewritten, self stays mirrored. An empty call leaves the board open —
  closing it is the person's call — and the window closes with the app.
- **Every video is muted**, as in pip.ts: remote audio has exactly one
  output path (the dock's sinks), and a second would double every voice.
- **The button** ("pop out all", `voice-board-toggle`) sits on the call bar
  before the tiles/spotlight switch, only while some tile has live video —
  an audio-only board is a window of black. Lit while open; a second press
  closes it. A blocked pop-up does nothing visible beyond the browser's own
  blocked-pop-up notice; the in-app expanded view is a one-tile thing and
  does not stand in for a board.

### 120-2 — a boarded tile rests in the main window

scuq, first use: the board opened but the main window kept painting every
tile too, where a single pop-out (47-11) unmounts its `<video>` and shows
"⧉ popped out" in its place. The board now does the same: while it is open,
every tile it holds (`onBoard` in `VoiceCallPanel.tsx`: live video, on a
board that is up) renders as popped out — the `<video>` gone, the mark in
its place — and its per-tile pop-out button goes with it, since the way
back is the bar's "pop out all", which closes the board for everyone at
once. A tile that was already in a window of its own stays marked either
way. The audio path is untouched: the dock's sinks never depended on the
stage's `<video>` elements.

**Rejected:** an in-app board (a modal canvas). The ask was a window: a
second monitor, or beside another app, is the point. **Rejected:** a
Preact render into the pop-up. pip.ts's DOM-by-hand pattern is small and
already proven against the CSP; a second Preact root in another document
is more machinery than a strip, a video and a drag.

**Left open:** the layout is not remembered — the grid comes back each
opening. Persisting rects per channel (per user id, so a person keeps their
slot) is the obvious next slice.

## Manual checklist

- [ ] In a call with two cameras and a share: "pop out all" opens one
      window with all three; drag by name, resize by corner, click raises.
- [ ] Someone turns their camera off: their tile leaves the window; on
      again: it returns, cascaded, without disturbing the others.
- [ ] Self is mirrored on the board as on the stage; a share is not.
- [ ] Closing the window unlights the button; pressing it again reopens
      with a fresh grid. Closing the app closes the board.
- [ ] With 118's box on in Chrome: the board floats; off: it does not.
- [ ] Firefox and Safari: the plain window path works, resize corner shows.

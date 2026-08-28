# Phase 47 — thread inbox filtering, tile pop-outs, and colour correctness

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.48 – v0.3.51; 47-11 added 2026-08-29.
**Tags:** `#threads`, `#voice` → `tools/where.sh -g threads`

## Why

A grab-bag phase, held together by "the thing on screen is lying to you":

- The threads panel sorted by recency but rendered every row at equal weight, so
  a conversation still going looked the same as one that stopped yesterday.
- Its filter matched only what a row *displayed* — channel, last replier, two
  preview lines — so searching for a word that appeared anywhere else in a
  thread found nothing and made threads disappear from the list.
- The pop-out button was on the big tile only and a second pop-out replaced the
  first, so exactly one thing could be watched outside the app.
- Status colours and nick colours were taken from the theme, so "online" showed
  up orange, red or blue depending on the theme — and on LCARS online and away
  were both amber.

## What landed

- **47-1 / 47-2** — thread inbox fades with age (ten minutes → a week, in
  steps, restored on hover/focus) and takes a client-side filter.
- **47-3** — keep the call bar visible in a voice channel; the typing line gets
  its own row.
- **47-4** — pop out any number of call tiles, each into its own window; tiles
  tidy themselves up when their video ends or the call is left.
- **47-5** — paint nick colours with an inline `hsl()` and tint the roster,
  voice occupants and members panel. (The previous mechanism was ignored
  entirely on some browsers, collapsing every name to one shade.)
- **47-6 / 47-10** — fixed presence colours across all themes, including the
  self presence pill: green online, amber away, hollow grey ring offline.
- **47-7** — relax all three away-detection windows.
- **47-8** — the thread filter searches every message of a thread this device
  has decrypted, and a matching row previews the line that matched.
- **47-9** — darkord theme; azeroth goes forest green.
- **47-11** (2026-08-29, long after the rest) — a tile whose video is showing
  in its own window rests in the app: its `<video>` is unmounted and the
  avatar carries a "⧉ popped out" caption until the window closes from
  either side. Asked for from the desktop shell, where the same frames were
  being painted twice; applies to every browser. The `<video>` is unmounted
  rather than overlaid (the overlay trick in `.chalk-voice-avatar--overlay`
  exists to avoid remount flicker when a camera blinks) because not painting
  is the point, and the flicker on the way back follows a deliberate close.

## Where it lives

`web/src/chat/threadinbox.ts` (and `threadinbox.test.ts`),
`web/src/components/ThreadInboxPanel.tsx`, `web/src/components/MembersPanel.tsx`,
`web/src/components/Sidebar.tsx`, `web/src/theme.css`.

## Notes

Filtering can only ever cover what this device decrypted — that is a property of
the encryption, not a limitation to fix. The panel says so rather than implying
a server-side search exists.

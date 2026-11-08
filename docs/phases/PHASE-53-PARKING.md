# Phase 53 — the parking lot

*Backfilled record.* Written after the fact from the commit history and the
changelog; 53-4/53-5 are recent enough that the commit messages are the fuller
account.

**Status:** shipped, v0.4.4 (53-1), v0.4.7 (53-2), v0.5.7 (53-3); 53-4 to 53-6 are
in `## Unreleased`.
**Tag:** `#parking` → `tools/where.sh -g parking`

## Why

Somewhere to put chalk when someone walks up behind you. The requirement is not
"lock the app" — locking would end calls, drop presence and tell the people you
are talking to that you left. Parking keeps chalk **open and connected** and
simply stops showing anything: no messages, no names, no half-typed line.

Consequences that had to be designed rather than fall out:

- **Nothing gets marked read while parked**, and no notification shows content —
  a sound still tells you something arrived, without saying what.
- **It survives a reload**, so refreshing does not drop you back into the last
  conversation. That is also why chalk *starts* parked (53-2) rather than
  auto-picking the most recently created channel.
- **Coming back is exact** (53-4): the same channel, thread and side panel you
  had, not a trip through the channel list.
- **A panicked double-tap must not undo the hide** (53-3/53-4): a press in the
  first moment after parking is ignored.
- The privacy screen (53-5) is **off by default** — chalk always starts parked,
  and a blurred window on every reload would be a strange greeting.

## What landed

- **53-1** — the parking lot: the sidebar row between friends and threads, the
  empty field, the renameable label synced across devices, the off switch.
- **53-2** — startup lands in the parking lot, not an auto-picked channel.
- **53-3** — F9 boss key parks from anywhere, closing the side panel with the
  messages; voice binds can no longer claim F9.
- **53-4** — F9 brings you back as well: restore the exact prior view, with a
  guard window against the double press.
- **53-5** — the privacy screen: with it on, the channel list, friends, your own
  name and the call bar are blurred, the tab stops showing the unread count, and
  notification sounds go quiet until you come back.
- **53-6** — the mark on the parking screen stands still. It had an endless
  28 s drift animation (a 3% shift and a 2% scale change) as a screensaver
  against burn-in. Only the operating system setting for reduced motion
  stopped it. A parked chalk made a new frame at every screen refresh, and
  each frame also went through the GPU process and the window manager. On
  Linux, a user saw about 18% on the renderer, 16% on the GPU process, and
  15% on the window manager while the window was idle. The change removes the drift.
  Rejected: a script that moves the mark one step each minute, and an instant
  jump. The owner chose the simplest fix and accepted the loss of the drift.
  `theme-parking.test.ts` checks that the rule has no animation.

## Where it lives

`web/src/parking.ts` (and `parking.test.ts`), `web/src/parking-hotkey.ts`,
`web/src/state/reducer.ts` (and `reducer-parking.test.ts`),
`web/src/notify/banners.ts`, `web/src/components/App.tsx`,
`web/src/components/Sidebar.tsx`, `web/src/components/ProfilePanel.tsx`.

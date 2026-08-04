# Phase 50 — notification rules

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.4.0 (50-1…50-7), v0.5.8 (50-8 title blink).
**Tag:** `#notify` → `tools/where.sh -g notify`

## Why

Phase 40 gave chalk sounds, one per event type, each with an on/off checkbox.
That does not survive contact with a busy server: what you want is "this channel
never, this friend always, mentions louder than channel chatter" — a *policy*,
not a list of toggles.

The model:

- Every notifiable event is assigned a **priority**. The priority decides what
  happens — sound, desktop banner, tab blink, or nothing.
- **Rules override** in a fixed order: a person's rule beats their channel's,
  which beats the defaults.
- **Rules sync, preferences do not.** Rules name who and what you have singled
  out, which is exactly the metadata chalk refuses to hand the server — so they
  are encrypted client-side under an identity-derived key and the server stores
  only ciphertext. Volume, do-not-disturb and chalk's own noises stay per device.
- **Banners are rendered by the OS from locally decrypted content** — nothing
  leaves the device. They collapse to one per channel (tag collapse) and tear
  down when the thing is read *anywhere*, including on another device.
- The unread count on the tab and app icon stays visible under do-not-disturb:
  silencing interruptions should not hide what is waiting.

## What landed

- **50-1** — rules engine core: priorities, profiles, the notification bus, a v1
  seed migrating existing per-category mutes.
- **50-2** — bus wired: event sounds, prefs v2 split, rules-driven sound sink.
- **50-3** — banner and blink sinks: `decideBanner` gate, tag collapse, teardown
  on read.
- **50-4** — the rules panel: priority matrix, per-user/channel rules, banner
  permission request.
- **50-5** — sidebar context menus quick-set priority for friends and channels,
  writing the same rules the panel does.
- **50-6** — rules sync across devices, encrypted under the identity-derived
  key.
- **50-7** — unread badge in the tab title and the app icon; the notification
  model doc.
- **50-8** — the title's attention marker travels end to end instead of blinking
  in place, stepping the unread count aside while it moves.

## Where it lives

`web/src/notify/` — `gate.ts` (and `gate.test.ts`), `banners.ts`, `types.ts`,
`index.ts`; `web/src/components/ProfilePanel.tsx`,
`web/src/components/Sidebar.tsx`, `web/src/state/reducer.ts`.

## Notes

Web **push** — notifications when no tab is open at all — is a separate,
unstarted phase: [PHASE-65-PUSH.md](PHASE-65-PUSH.md).

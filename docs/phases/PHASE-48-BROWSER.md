# Phase 48 — browser reality: storage, IME, curves and lost drafts

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.52 / v0.3.53. See also
[browser-support.md](../browser-support.md).
**Tag:** `#browser` → `tools/where.sh -g browser`

## Why

chalk assumed a browser that has secure-context WebCrypto, working site storage,
and Latin text entry. Each assumption failed somewhere real:

- **Private browsing / plain http** — a blocked `localStorage` or an insecure
  context made the app fail before anything appeared on screen, including the
  device-id bootstrap.
- **Old browsers** — chalk's identity derivation needs X25519/Ed25519 in
  WebCrypto. Without it, entering a perfectly correct recovery phrase failed with
  a generic error indistinguishable from a typo. The fix is to **probe the curves
  at boot** and name the versions that work (Safari 17+, Firefox 132+,
  Chrome/Edge 137+), and to point out when the real problem is a plain-http
  address.
- **IME composition** — pressing Enter to pick a Japanese/Chinese/Korean
  candidate sent the half-composed buffer, and emoticon replacement garbled text
  mid-composition.
- **Lost text** — hitting Enter as the connection dropped, or before the
  channel's key had arrived, cleared the box and sent nothing.

The rule these share: **fail loudly and specifically, or do not fail at all.**
Never silently discard the user's text, and never report a capability problem as
a credential problem.

## What landed

- **48-1** — a refused text-only send keeps the draft.
- **48-2** — ignore Enter and emoticon swaps during IME composition.
- **48-3** — device id survives missing `localStorage` and insecure contexts.
- **48-4** — probe WebCrypto curves at boot and name unsupported browsers.
- **48-5** — the thread inbox rolls back unwarmed channels so previews retry
  instead of sitting on the loading shimmer forever.
- **48-6** — the roster long-press colour menu survives the synthesized click
  (it opened and instantly closed on touch; on iOS it also popped the
  text-selection bubble).
- **48-7** — voice call controls consolidate into the global panel; the gear
  icon stops reading as a sun.
- **48-8** — idle voice controls fade to whisper strength.

## Where it lives

`web/src/crypto/support.ts`, `web/src/auth/UnsupportedBrowserScreen.tsx`,
`web/src/ws-client.ts`, `web/src/components/Composer.tsx`,
`web/src/webauthn.ts`, `web/src/chat/press.ts`.

## Notes

go-webauthn v0.17's BE/BS flag validation (the "Backup Eligible flag
inconsistency" login failure) is adjacent but not this phase — it is handled by
migration 0042 and `adoptLegacyFlags` in `internal/auth/http.go`.

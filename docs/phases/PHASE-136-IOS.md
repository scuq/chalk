# Phase 136 — ios: a wrapper app that keeps a call running in the background

A plan for a small iPhone app that wraps the chalk web page.
The goal is that a voice call continues when the user switches apps or locks the screen.
**NOT IMPLEMENTED — no code exists.** This document is the plan and nothing below it has been built.

**Status: planned, not started.** Design only, written 14 November 2026.
**Tag:** `#ios` → `tools/where.sh -g ios` (which today finds this file and nothing else, because there is nothing else).

Decisions from the owner:

- The owner has a Mac and no paid Apple Developer account.
- The app is for the owner and the users of the owner's server. It is not a public App Store listing.

---

## Problem

On an iPhone, a voice call in the chalk Home Screen app stops when the user switches apps or locks the screen.
The phone call view already tells the user.
It shows "the call pauses while chalk is in the background" (`web/src/components/PhoneCallSheet.tsx:299-303`).
This notice is the only handling today.

Reports say that iOS blocks web audio and microphone input when a web page is not in the foreground.
The sources are developer reports, not Apple documentation (see Sources).
No device result exists, so each statement in this section is expected behavior, not a measured fact.

The call topology makes this worse.
The voice design uses a mesh with coturn.
Each participant holds N-1 peer connections, and the design says it is not an SFU (`docs/design/chalk-phase-30-voice-video-design.md`, section 2, "Topology (decided)").
The phone's own peer connections carry the media.
So the web view process must keep running in the background for the call to continue.
No server-side media exists to fall back on.

If the page stops in the background, the server also removes the user from the call:

- chalkd removes a voice participant when its socket ends (`voiceDisconnect`, `internal/server/voice_ws.go:548-571`).
- The ping loop finds a silent socket in about 45 s (`PingInterval` 15 s and `PingTimeout` 30 s, `internal/server/ws.go:94-95`, loop at `internal/server/ws.go:1213-1233`).
- The client parks a capture for 30 s after a socket loss (`PARK_MS`, `web/src/voice/parked-media.ts:15`).

## Design

The app is a thin shell on the pattern of the desktop app (phase 104, [PHASE-104-DESKTOP.md](PHASE-104-DESKTOP.md)).

- One `WKWebView` loads `https://<server>/` and nothing else.
  The app bundles no part of chalk.
  The server pin, the session cookie, and all crypto stay in the page and stay keyed to the server origin, as in `docs/phases/PHASE-104-DESKTOP.md:37-44`.
- `Info.plist` lists `audio` in `UIBackgroundModes`.
  Developer reports say that the web view then keeps microphone capture in the background, and that iOS mutes it without the key.
  This is unconfirmed until slice 136-1.
- The app grants camera and microphone to the server origin through the web view's media-capture delegate, so the page prompt shows one time.
- Navigation stays on the server origin.
  Other links open in Safari.
  The rule follows `classifyLink` (defined in `desktop/src/links.ts:23`, used in `desktop/src/main.ts:209-243`).
- The first screen asks for the server address and stores it, as `desktop/src/config.ts` does.
  The desktop config accepts plain http only for loopback hosts, or when the caller allows it.
  The iOS app has no such flag and refuses plain http, because the session cookie is `Secure`.
- A new directory `ios/` holds the Xcode project.
  The code is Swift, with no third-party package.

## Rejected

- CallKit in the first version.
  A web view runs audio in a separate process with its own audio session.
  Reports say that a CallKit session then breaks the web view's capture, and no fix from Apple is known.
- PushKit.
  chalk has no ring: a voice room has join and leave only.
  Reports say that iOS requires each VoIP push to report an incoming call.
- Native WebRTC in Swift.
  It duplicates `web/src/voice/` and moves key handling out of the page.
- A bundled copy of the web client.
  It splits the trust model, because today the home server serves the client.
- A public App Store listing.
  Reports say that Apple often rejects an app that is only a web view (guideline 4.2).
- Web-only tricks: picture-in-picture, a silent audio loop, and a wake lock.
  They are expected not to keep the microphone.
  Slice 136-1 does not test them.

## Slices

All slices are not started.

| Slice | Content | Status |
| --- | --- | --- |
| 136-1 | Device test, the gate for the phase. See below. | not started |
| 136-2 | The shell: server address screen, navigation rule, permission grant, safe areas, file download, app icon. | not started |
| 136-3 | The web client knows the shell. See below. | not started |
| 136-4 | Notifications in the shell. A decision first. See below. | not started |
| 136-5 | Distribution. See below. | not started |
| 136-6 | Optional: lock-screen call controls and audio route selection. Use CallKit only if a later iOS version removes the conflict. | not started |

### 136-1 device test

The slice builds a minimal app: one web view, the `audio` background mode, the usage strings, and free signing from Xcode.
Measure on a real iPhone, in a call with a second device:

- Audio in both directions after an app switch, and after a screen lock, at 10 s, 60 s, and 5 min.
- The state of the WebSocket in the background.
- The call after a phone call interrupts it.
- The values of `"PushManager" in window` and `"Notification" in window`, and if WebAuthn works in the web view.
- The iOS versions tested.

If the microphone stops in the background, the phase stops here and this document records the result.

The only in-repo evidence about a WKWebView is the engine table in `docs/phases/PHASE-104-DESKTOP.md:60`.
That row is about macOS, not iOS.
It says: "no `Notification`, no WebAuthn, no `setSinkId`".
Do not assume that the iOS web view has the same limits.
The test finds out.

### 136-3 the page knows the shell

The shell marks itself, with a user agent suffix or a script message handler.
The page then hides the background notice in `web/src/components/PhoneCallSheet.tsx` and the Home Screen hint in `web/src/components/PushSettings.tsx`.
Today `pushSupported` in `web/src/notify/push.ts` decides if push is offered.
If the socket closes in the background, this slice defines the fix.
A grace period on the server is a possible fix and needs its own decision.

### 136-4 notifications

Expected: a web view app has no web push, so phase 65 ([PHASE-65-PUSH.md](PHASE-65-PUSH.md)) does not work inside it.
136-1 gives the facts.
Two options exist:

- A native Apple Push Notification service (APNs) sender in chalkd.
  It adds an Apple key and a new third party to the threat model.
- No push in the shell.

### 136-5 distribution

Free signing expires after 7 days, so it serves 136-1 only.
A paid Apple Developer account is the precondition for TestFlight.
Check Apple's current rule for the review of internal TestFlight builds before this slice.

## Threat model draft

This text goes into `docs/threat-model.md` with the first built slice.
Nothing in that file changes now.

- The shell is a new binary that the user must trust.
  The developer signs it and Apple delivers it.
  It can read all that the page shows.
  The desktop app has the same property ([threat-model.md](../threat-model.md), "The desktop app's update channel", lines 368-395).
- The home server still serves the client.
  The statement in `docs/threat-model.md:209-215` does not change.
  The statement says that a MITM that serves the SPA bundle itself is endpoint compromise.
- A native APNs sender, if 136-4 selects it, is a second third party after web push (`docs/threat-model.md:396-470`).
- Passkeys possibly do not work in the web view.
  Associated domains are compiled into the app, and each server has its own domain.
  Password with TOTP is not affected.
  136-1 tests this.

## Preconditions and unknowns

- A Mac with Xcode: present.
- A paid Apple Developer account: absent, and necessary from 136-5.
- Background capture: unknown. No device result exists for any claim in this document about background capture.
- The behavior of passkeys, `Notification`, and `PushManager` in a web view on iOS: unknown until 136-1.
- The iOS versions that matter: unknown until 136-1.

## Sources

The owner's research read these pages through search summaries on 14 November 2026.
Read each page in full before 136-1.

- [WebKit bug 198277](https://bugs.webkit.org/show_bug.cgi?id=198277): audio stops when a standalone web app leaves the foreground.
- [Apple forums 689182](https://developer.apple.com/forums/thread/689182): the WKWebView `getUserMedia` microphone is muted in the background, and the report says the `audio` background mode fixed it.
- [Apple forums 713084](https://developer.apple.com/forums/thread/713084): if `UIBackgroundModes` audio is required for WKWebView background audio.
- [Apple forums 767949](https://developer.apple.com/forums/thread/767949): CallKit breaks web-based MediaStreams.
- [Apple forums 685268](https://developer.apple.com/forums/thread/685268): how to integrate CallKit with WebRTC in a WKWebView.
- [Apple forums 774239](https://developer.apple.com/forums/thread/774239): Safari should allow background WebRTC.
- [Apple forums 128667](https://developer.apple.com/forums/thread/128667): CallKit requirements for a VoIP push.
- [Apple forums 806726](https://developer.apple.com/forums/thread/806726): guideline 4.2, minimum functionality.

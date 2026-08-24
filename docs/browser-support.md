# Browser Support

chalk targets modern browsers across desktop and mobile:

| Engine | Platforms covered |
|---|---|
| Chromium | Chrome, Edge, Brave, Opera (desktop + Android) |
| Gecko | Firefox (desktop + Android) |
| WebKit | Safari (macOS, iOS, iPadOS) |

## Minimum versions (support floor)

chalk's identity keys use the native WebCrypto Curve25519 algorithms.
**X25519** has been available across all three engines for some time, but
**Ed25519** shipped later — and it is the binding constraint:

| Engine | Minimum version | Ed25519 shipped |
|---|---|---|
| Chromium (Chrome/Edge/Brave/Opera) | **137** | May 2025 |
| Gecko (Firefox) | **129** | Aug 2024 |
| WebKit (Safari) | **17.0** | 2023 |

Below these, `crypto.subtle` lacks native Ed25519 and chalk shows the
"your browser is too old" page rather than degrading. This deliberately
narrows the usual "~2 years" window for Chromium (137 is ~13 months old as
of mid-2026) in exchange for zero bundled crypto — no JS/WASM crypto ships
in chalk; every primitive is native WebCrypto. The window widens naturally
as Chrome 137+ proliferates (expected to be broadly safe to assume ~2027).

## The desktop app

The desktop app (`desktop/`, phase 104) is an Electron shell around the
server's page, so its engine is whatever Chromium the pinned Electron embeds —
Electron 43 carries Chromium 150, above the floor by a wide margin — and the
support question there is the platform, not the browser:

| Platform | Builds | Everything works? |
|---|---|---|
| Windows 10/11 | x64, arm64 | yes (passkeys via Windows Hello) |
| macOS 12+ | Apple Silicon, Intel | yes except passkeys (needs a native module, not yet) |
| Linux (glibc, X11 or Wayland) | x64, arm64 | yes; tray needs a StatusNotifier host, screen lock is not reported |

The floor moves with Electron's stable line, one Chromium major behind
Chrome stable by design; `docs/phases/PHASE-104-DESKTOP.md` records the
bump policy.

## Required APIs

- WebSocket (RFC 6455) — universal
- WebCrypto (`crypto.subtle`) — including the Curve25519 algorithms **X25519** (key agreement) and **Ed25519** (signatures); see the support floor below
- WebAuthn / passkeys — universal in current versions
- Web Workers — universal
- IndexedDB — universal (used for the message cache and, from phase 22, the local identity private key)
- Page Visibility API — universal
- CSS custom properties — universal
- ES2022 modules — universal

If a browser is missing one of these, chalk shows a clear "your browser is too old" page rather than a half-broken UI.

## Tested via Playwright (CI)

Engines: Chromium, Firefox, WebKit
Viewports: desktop (1280×800), mobile-iOS (iPhone 14 emulation), mobile-Android (Pixel 7 emulation)

This catches the vast majority of cross-browser issues. Engine = what matters; OS chrome around the engine rarely affects a web app.

## Manual real-device verification

Some things can only be verified on real hardware:

- iOS Safari viewport jumping when the keyboard opens
- Real audio context unlock semantics (especially iOS)
- Real WebAuthn / passkey biometric flows
- Background tab suspension behavior under iOS Low Power Mode and Android Doze
- WebSocket reconnect across cellular ↔ WiFi handoff
- OS notification appearance and behavior

Phase 13 generates a manual test checklist for these. Run through it on at least one iOS device and one Android device before any release.

## Known platform quirks we accommodate

- **iOS Safari**: 100vh includes the dynamic toolbar; we use `100dvh` with a fallback. AudioContext must be created/resumed inside a user gesture handler.
- **Android Chrome**: aggressive background tab suspension; we report `away` on `visibilitychange` immediately and accept that the WebSocket will get killed.
- **Firefox**: stricter about `font-display`; we use `swap` for all faces.
- **Safari**: IndexedDB has historically been quirky (origin partitioning in 14, etc.); we exercise it heavily in CI.

## Not supported

- IE 11 (long dead)
- Pre-Chromium Edge
- Anything older than the minimum versions above (the Ed25519 floor, not a flat ~2 years)

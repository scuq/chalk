# Phase 138 — macos: a native app replaces the Electron build on macOS

A plan for a native macOS app, written in Swift, that wraps the chalk web page in a `WKWebView`.
It replaces the Electron build (phase 104) on macOS only.
The design is dated 16 November 2026.

**Status: in progress.** Slice 138-1 exists as code that nobody compiled or ran. The measurement is open. Slices 138-2 to 138-11 are not started.
**Tag:** `#macos` → `tools/where.sh -g macos` (this file, `ios/chalkMac/`, and `ios/Shared/`).

Decisions from the owner (16 November 2026):

- Distribution is a notarized Developer ID build on GitHub Releases, with an updater written for this app. The app does not use Sparkle.
- The first version includes native notifications and push, a Dock badge, a menu bar unread mark, and native idle and lock detection.
- The Electron build for macOS stays until the Swift app has parity. One last slice removes it.

---

## Problem

The macOS desktop app is an Electron shell (phase 104, [PHASE-104-DESKTOP.md](PHASE-104-DESKTOP.md)) of about 100 MB.
It is ad-hoc signed, so the first start needs a right-click.
It has no passkeys, no native push, and no Dock badge.
Phase 136 ([PHASE-136-IOS.md](PHASE-136-IOS.md)) built a Swift shell for iOS, and most of its logic is not specific to iOS.
This phase builds a Swift app for macOS from that code and adds macOS integration.

Three facts set the limits of the phase:

- Electron stays for Windows and Linux. Linux has no system web view with WebRTC (phase 104 research).
- The app loads the page of the home server and bundles no part of chalk. Phases 104 and 136 rejected a bundled client.
- The development machine has no Swift toolchain. The owner compiles and tests on the Mac, as in phase 136.

The phase number is 138. The index in `docs/phase-log.md` ended at 137, and no planned phase covers a native shell.

## Main risk

`docs/phases/PHASE-104-DESKTOP.md` rates a macOS `WKWebView`.
Calls work, and screen share works on macOS 14 and later.
The page has no `Notification`, no WebAuthn, and no `setSinkId`.
That table came from research, not from a measurement.
Slice 138-1 measures each item on the Mac before other code is written.
A native bridge replaces `Notification` (slice 138-5).
The other gaps get a slice or a recorded limit after the measurement.

## Design

### Project layout

- Add a macOS app target, `chalkMac`, to `ios/chalk.xcodeproj`. The owner adds the target in Xcode, because the project file is maintained there.
- Move the platform-neutral Swift files from `ios/chalk/` to a new synchronized folder, `ios/Shared/`. Both app targets compile that folder.
- Put the macOS-only code in `ios/chalkMac/`.
- Set the deployment target to macOS 14.0. The shared code uses `@Observable`, which needs macOS 14.
- Build one universal binary (arm64 and x86_64).

The plan moves these files to `ios/Shared/`:

- `AppModel.swift`
- `LinkRule.swift`
- `PushContent.swift`
- `PushCrypto.swift`
- `PushKeys.swift`
- `ServerAddress.swift`
- The WebKit-only half of `PushRegistrar.swift` (`PushOpenRouter`, `PushBridge`, `originString`)


`PhoneCallTracker.swift` stays in the iOS target, and `ShellMark` gets a macOS sibling.
The tests in `ios/chalkTests/` that use only Foundation and CryptoKit run for both platforms.

Slice 138-1 moves a smaller set (see "Result of 138-1").

Rejected:

- Mac Catalyst and the iPad app on Mac. Neither gives a menu bar item, and both keep UIKit windowing.
- A separate `macos/` project. Two projects cannot share a synchronized folder without path references outside the project.
- A rename of `ios/` to `apple/`. The rename changes every path in phase 136 for no function.

### Bridge to the page

The Swift app keeps the names the page already knows, so that most page code needs no change.

| Bridge | Direction | Contract | Page change |
| --- | --- | --- | --- |
| Shell mark and idle | both | `window.chalkDesktop = {shell: "chalk-macos/<version>", platform: "darwin", idle: {get, subscribe}}`, the shape in `desktop/src/preload.ts` | none, `web/src/presence/desktop-idle.ts` detects it |
| Push | page to app, reply | handler `chalkPush`, the phase 136 contract in `web/src/notify/ios-push.ts` | availability text in `web/src/notify/push.ts` and `PushSettings.tsx` |
| Open target | app to page | the `chalk-ios-open` event, reused | none |
| Notify | page to app | new handler `chalkNotify`: title, body, tag, target | `web/src/notify/banners.ts` |
| Badge | page to app | new handler `chalkBadge`: unread count | one call where the page computes the unread total |

Each handler answers only the main frame of the home server origin, as `PushBridge` does.
A document-start user script defines `window.chalkDesktop` and forwards `idle.get` and `idle.subscribe` to a `chalkIdle` handler.

### Native parts

- Idle and lock: `CGEventSource.secondsSinceLastEventType` for idle time, the `com.apple.screenIsLocked` and `com.apple.screenIsUnlocked` distributed notifications, and the `NSWorkspace` sleep, wake, and session notifications. The values match `desktop/src/idle.ts`: a 15 s poll and a `locked` flag that the app derives on each read.
- Menu bar item: `NSStatusItem` with Open, Switch server, Check for updates, and Quit. A close of the window hides it, as `closeToTray` does in the Electron app.
- Server picker: `ServerScreen.swift` with `#if os(iOS)` guards on the three iOS-only modifiers. `AppModel` gets the remembered server list that `desktop/src/config.ts` has.
- Web view host: an `NSViewRepresentable` with the navigation rules of `ChalkWebView.swift`. Camera, microphone, and screen capture go only to the home server origin.
- Child windows: one `NSWindow` for each page pop-up, with the same navigation lock. The call pop-out of slices 104-6 and 104-7 uses this.
- Downloads: `WKDownloadDelegate` writes to the Downloads folder.
- Server address: https only. A debug build also accepts plain http to loopback.

### Signing, release, and update

- The app has the hardened runtime and no App Sandbox. An app in the sandbox cannot replace its own bundle.
- The release job signs with a Developer ID certificate, notarizes with `notarytool`, and staples the ticket.
- The archive is `chalk-desktop-<version>-macos-native.zip` and holds `chalk.app`. The name matches the `chalk-desktop-*` glob, so `SHA256SUMS.desktop` and its Ed25519 signature cover it with no change to the signing steps.
- The version rule of `PHASE-136-IOS.md` ("Version of the app") applies when the target is created. The project file carries the chalk version, and the owner sets it by hand.
- The updater is a Swift port of phase 105. It reads the same release, the same signed table, and the same pinned key as `desktop/src/selfupdate/key.ts`.
- Before the swap, the updater also checks that the new bundle has a valid code signature from the same team. `PHASE-105-SELFUPDATE.md` names this requirement for a notarized app.
- A test in `desktop/` reads both key constants and fails when they differ.

### Push

- The first try uses the iOS bundle identifier, `at.73c.chalk`, for the macOS app. One `CHALK_APNS_TOPIC` then serves both, and chalkd needs no change.
- If Apple does not issue a Developer ID profile with push for that identifier, chalkd gets a list of topics. That is a server slice, and it needs approval first.
- A notification service extension decrypts a push while the app is closed. It uses `PushCrypto` and `PushContent`. The rest of 136-4d needs the same extension, app group, and keychain access group, so both platforms share one design.
- The app stays alive in the menu bar, so a push and a page banner can both fire for one message. Slice 138-8 reads the fan-out rule in `internal/server/push_dispatch.go` first, then picks one source.

## Slices

Slices 138-1 to 138-7 need no paid Apple Developer account. Slices 138-8 to 138-10 need it.
The owner has no active account yet (see PHASE-136-IOS.md).

| Slice | Content | Status |
| --- | --- | --- |
| 138-1 | Measurement. Create the target and `ios/Shared/`. Load the home server in a bare window. Run the checklist below on the Mac. Create the phase doc, the tags line, and the index row. | written, not compiled, measurement open |
| 138-2 | The rest of shell parity: the server list in the picker, window position memory, and plain http to loopback in a debug build. The first macOS test target. Slice 138-1 already holds the navigation and permission rules, downloads, child windows, and the Switch Server command. | not started |
| 138-3 | Menu bar item and hide on close. A call continues while the window is hidden. | not started |
| 138-4 | Idle and lock detection through the `chalkDesktop` bridge. | not started |
| 138-5 | Notification Center banners while the app runs, through `chalkNotify`. A click opens the channel. | not started |
| 138-6 | Dock badge and menu bar unread mark, through `chalkBadge`. | not started |
| 138-7 | Gaps from 138-1. Each failed item gets a native path or a recorded limit that the owner accepts. | not started |
| 138-8 | Native push: token registration for macOS, the entitlement, the extension, and the availability text in the page. Needs the account. | not started |
| 138-9 | Developer ID signature, notarization, the `release.yml` job, a macOS test step in `ci.yml`, and the README download text. Needs the account. | not started |
| 138-10 | Self-update in Swift. Needs the account. | not started |
| 138-11 | Removal of the Electron build for macOS, after a parity review with the owner. | not started |

Commit messages are `phase 138-<slice>: <summary>`. The owner commits.

### Slice 138-11 in detail

- Remove the two macOS rows from the `desktop` matrix in `.github/workflows/release.yml`, and the ad-hoc signing and zip steps.
- Remove the darwin branches in `desktop/src/selfupdate/updater.ts`, `desktop/src/selfupdate/apply.ts`, `desktop/src/main.ts`, `desktop/src/screenshare.ts`, and `desktop/package.mjs`, with their tests.
- One last Electron release for macOS tells the user to download the native app. The page session does not move between the two apps, so the user signs in again and enters the encryption phrase again.
- The native app reads the server list from the Electron `desktop.json` on first start, if the file exists.
- The native app needs macOS 14. The Electron build ran on macOS 12. The owner accepts or rejects this limit in the parity review.

## Result of 138-1

The code is written on a machine with no Swift toolchain.
It is not compiled and not run.
The owner builds it on the Mac, and when the Mac finds a compile error, the same slice corrects it before the commit proposal.

### What changed in code

- Moved from `ios/chalk/` to the new folder `ios/Shared/`: `LinkRule.swift`, `ServerAddress.swift`, `AppModel.swift`, and `ServerScreen.swift`.
- New `ios/Shared/Origin.swift` holds `originString`, moved out of `ios/chalk/PushRegistrar.swift`.
- `ios/Shared/AppModel.swift` has a new `chooseServer()`.
- `ios/Shared/ServerScreen.swift` has `#if os(iOS)` and `#if os(macOS)` guards.
- New `ios/chalkMac/chalkMacApp.swift`: the app, one window, and a **Switch Server…** menu command on Command-Shift-S.
- New `ios/chalkMac/MacWebView.swift`: the web view host.
  - Navigation rules.
  - Downloads to the Downloads folder.
  - Camera and microphone only for the https server origin.
  - A file open panel.
  - Child windows.
- New `ios/chalkMac/chalkMac.entitlements`: hardened runtime entitlements for audio input and camera.
- `ios/chalk.xcodeproj/project.xcproj`: one line added, so that the iOS target compiles `ios/Shared/`.

### Differences from the design

- The push files stay in `ios/chalk/` for now: `PushContent.swift`, `PushCrypto.swift`, `PushKeys.swift`, and `PushOpenRouter` and `PushBridge` in `PushRegistrar.swift`. They move to `ios/Shared/` in slice 138-8, when the macOS app first uses them.
- There is no macOS test target yet. It arrives in 138-2 with the first macOS logic that has tests.
  For 138-1 the Mac check is to build the `chalkMac` scheme, and to run `xcodebuild test` for the `chalk` scheme. The second run proves that the file move did not break the iOS app.
- 138-1 does not define `window.chalkDesktop`. That arrives in 138-4.
- The web view uses only public WebKit API.
  If screen share fails in the measurement, a private WebKit preference is one possible path. That decision belongs to slice 138-7.

### Manual steps for the owner in Xcode

1. In `ios/chalk.xcodeproj`, add a macOS App target named `chalkMac` (SwiftUI). Keep the repository files in `ios/chalkMac/`, and discard the template sources that Xcode generates there, except an asset catalog.
2. Set the folder membership: `ios/Shared/` belongs to `chalk` and `chalkMac`, and `ios/chalkMac/` belongs to `chalkMac`.
3. Set the target settings:
   - Product name: `chalk`.
   - Bundle identifier: `at.73c.chalk`.
   - macOS deployment target: 14.0.
   - Hardened runtime: on.
   - App Sandbox capability: removed.
   - `CODE_SIGN_ENTITLEMENTS`: `chalkMac/chalkMac.entitlements`.
4. Add the usage strings `NSMicrophoneUsageDescription` and `NSCameraUsageDescription`, with the same text as `ios/Info.plist`.
5. Build the `chalkMac` scheme, and run `xcodebuild test` for the `chalk` scheme.
6. Run the checklist below, and write each result into this file.

### Checklist for 138-1

The owner runs these on the Mac and this file records each result.
Record the macOS version with the results.

| # | Check | Result |
| --- | --- | --- |
| 1 | Sign in with password and TOTP, then send and receive a message. | |
| 2 | Quit and start the app again. The session and the IndexedDB identity are still present. | |
| 3 | Join a call with microphone and camera, with a second participant in a browser. | |
| 4 | Hide, minimize, and cover the window during the call for five minutes. The audio continues in both directions. | |
| 5 | Share the screen. Record which picker appears and the macOS version. | |
| 6 | Select a different output device in the call settings (`setSinkId`). | |
| 7 | Register and use a passkey. | |
| 8 | Read `typeof Notification` and `navigator.serviceWorker` in the page. | |
| 9 | Download an attachment and print the recovery phrase page. | |
| 10 | Open the call pop-out window. | |

Item 4 decides if slice 138-3 needs a native measure against web view throttling.
Item 7 is expected to fail, because Apple ties passkeys in an app to domains listed at build time.
The result is recorded, and passkeys stay a known limit unless the measurement shows a path.

## Paperwork

- `docs/phases/PHASE-138-MACOS.md`: this file. It stays current as slices land.
- `docs/phase-log.md`: an index row for 138, marked in progress.
- `docs/tags.md`: the `#macos` line. Append 138 to `#presence`, `#push`, and `#selfupdate` as those slices land.
- `docs/threat-model.md`: a section for the macOS shell beside the iOS section, and a change to the update channel section in 138-10.
- `docs/open-items.md`: a 138 entry, and changes to the phase 104 entry in 138-11.
- `CHANGELOG.md`: the first bullet lands in 138-9, when a user can download the app.
- `README.md` and `docs/browser-support.md`: the desktop app sections, in 138-9 and 138-11.
- `PHASE-104-DESKTOP.md` and `PHASE-105-SELFUPDATE.md`: corrected in 138-11, so that no plan contradicts the code.

## Verification

For each slice:

1. On the development machine, run the full chain: `go build ./... && go vet ./...`, `gofmt -l .`, `go test ./...`, and in `web/` `npx tsc --noEmit`, `node test.mjs`, `node build.mjs`. In `desktop/`, run `npm test` when the slice changes that directory.
2. Page-side bridge changes get tests in the existing files: `web/src/presence/desktop-idle.test.ts`, `web/src/notify/ios-push.test.ts`, `web/src/notify/push.test.ts`, and a test beside `banners.ts`.
3. On the Mac, the owner runs `xcodebuild test` for the `chalkMac` scheme (from 138-2) and for the `chalk` scheme. The second run proves that the file move did not break the iOS app.
4. The owner runs the manual checklist of the slice in the built app, and this file records the result.
5. For 138-9 and 138-10, a tagged release must produce the notarized archive, and one real update must run from the previous version.

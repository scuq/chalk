# Phase 136 — ios: a wrapper app that keeps a call running in the background

A plan for a small iPhone app that wraps the chalk web page.
The goal is that a voice call continues when the user switches apps or locks the screen.
The design was written on 14 November 2026.

**Status: in progress.** Slice 136-1 is built and measured on a device (2026-11-16). The gate passed. Slice 136-2 is built and checked on a device (2026-11-16), with two checks open. A follow-up of 136-2 has a device check open. Slices 136-3 to 136-6 are not started.
**Tag:** `#ios` → `tools/where.sh -g ios` (this file and the `ios/` directory).

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
No device result exists for the Home Screen web app, so each statement in this section about it is expected behavior, not a measured fact.
Slice 136-1 measured the shell, not the Home Screen web app.
In the shell, the call continued in the background (see "Result of 136-1").

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
  Slice 136-1 showed this on a device: the `audio` mode was enough, and no fallback was necessary.
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

Slices 136-1 and 136-2 are built. The other slices are not started.

| Slice | Content | Status |
| --- | --- | --- |
| 136-1 | Device test, the gate for the phase. See below. | done, 2026-11-16 |
| 136-2 | The shell: server address screen, navigation rule, permission grant, safe areas, file download, app icon. | built, 2026-11-16. Open: the Settings toggle and the print window. See below. |
| 136-3 | The web client knows the shell, and mutes on a phone call. See below. | not started |
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

If the microphone had stopped in the background, the phase would have stopped here.
It did not stop, so the phase continues.

The only in-repo evidence about a WKWebView is the engine table in `docs/phases/PHASE-104-DESKTOP.md:60`.
That row is about macOS, not iOS.
It says: "no `Notification`, no WebAuthn, no `setSinkId`".
Do not assume that the iOS web view has the same limits.
Slice 136-1 measured `Notification` and `PushManager` in the iOS shell, and both are absent (see "Page facts").
It did not test if WebAuthn works (see "Open measurement").

### Result of 136-1

The owner measured on 16 November 2026.
The second participant was Chrome on a Mac.

#### What was built

The code is in `ios/`, a new directory.

- Xcode 27.2 made the project.
  It uses the new text project format: `ios/chalk.xcodeproj/project.xcproj`.
  The `chalk` source folder is a synchronized folder, so a new Swift file needs no project-file edit.
- `ios/chalk/ChalkWebView.swift` holds one `WKWebView`.
  It loads a hard-coded server URL, because the server address screen stays in 136-2.
  It sets `isInspectable` to true, allows inline media playback, and needs no user action to start media playback.
- A `WKUIDelegate` grants camera and microphone only if the requesting origin is https and has the same host and port as the server URL.
  Otherwise it denies.
- `ios/Info.plist` sets `UIBackgroundModes` to `[audio]` and has `NSMicrophoneUsageDescription` and `NSCameraUsageDescription`.
  The `INFOPLIST_FILE` build setting merges it into the generated plist.
  The file is outside the synchronized folder, so Xcode does not also copy it as a resource.
- `ios/.gitignore` covers build output and the per-user state of Xcode.
- Signing uses a free Personal Team.
  The deployment target is iOS 27.2, the default of Xcode.

#### Setup

- Device: iPhone 17 Pro with iOS 27.2.1 (24B156).
- Server: the local development stack in a Linux virtual machine.
  The phone reached it through ngrok on the free plan.
  An https tunnel with a static ngrok domain led to chalkd.
  An ngrok TCP tunnel led to coturn, which ran in its default loopback mode.
- chalkd advertised two TURN URLs: `turn:localhost:3478` and `turn:<host>.tcp.eu.ngrok.io:<port>?transport=tcp`.
- The environment of that chalkd:
  - `CHALK_PUBLIC_URL`, `CHALK_RP_ID`, and `CHALK_RP_ORIGINS` held the ngrok https origin.
  - `CHALK_TRUSTED_PROXY` was `127.0.0.1/32`.
  - `CHALK_DEV` was unset, so the session cookie kept `Secure`.
- The free plan of ngrok puts a warning page before browser user agents.
  One tap on **Visit Site** was enough.
  After that, the page, the API, and the WebSocket worked.

#### Build loop

1. Edit in the virtual machine.
2. Copy the tree to the Mac with rsync.
3. Build with `xcodebuild` over SSH, with `DEVELOPER_DIR` set to the `Xcode.app` path.

A device build over SSH fails with `errSecInternalComponent`.
The owner must run `security set-key-partition-list -S apple-tool:,apple:,codesign: -s <login keychain>` in Terminal on the Mac.
Until then, installs go through **Run** in Xcode.

#### Gotcha: a stale project in Xcode

Xcode kept its in-memory project and missed a change to `INFOPLIST_FILE` that was made on disk.
The built app then had no usage strings.
WebKit hid `navigator.mediaDevices` completely.
The page showed "undefined is not an object evaluating navigator.mediaDevices.getUserMedia".
Reopening the project fixed it.
Check the `Info.plist` of the built app before a device test.

#### Results

- Voice works in the foreground in both directions.
  The media went through TURN over TCP and ngrok.
- App switch: the call was held for more than 5 min (09:48 to 09:53 local time) with audio in both directions.
  The WebSocket stayed connected.
  chalkd logged no disconnect for the phone's device from 09:41 on.
- Screen lock: a separate clean run of 5 min had audio in both directions.
  The WebSocket stayed connected, and chalkd logged no disconnect.
- Incoming phone call: chalk audio came back after the user reopened the app.
  The owner accepts this.

The gate passes, and the phase continues.
The `audio` background mode was enough, so no fallback was necessary.

#### Page facts

The owner read these values with Safari Web Inspector on the Mac.
The shell sets `isInspectable`.

- `"PushManager" in window` is false. The shell has no web push, as phase 65 expected.
  The choice in 136-4 stands: a native APNs sender or no push.
- `"Notification" in window` is false.
- `!!window.PublicKeyCredential` is true. The WebAuthn API is present.
- `navigator.userAgent` is `Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148`.
  The OS version in the user agent is frozen at 18_7, but the phone runs iOS 27.2.1.
  So the page cannot read the real iOS version from the user agent.
  The user agent has no `Version/` token and no `Safari/` token, unlike Safari.
  This difference is a side effect of the default user agent of `WKWebView`, not a deliberate mark.
  Slice 136-3 still adds an explicit mark.

These results are for the shell.
The background behavior of the Home Screen web app is still unmeasured.

#### Open measurement

One measurement is open: if a passkey sign-in works in the web view.
The owner did not try it.
The API is present, but that does not show that a sign-in works.
The free Personal Team has no Associated Domains capability, so a failure would not isolate `WKWebView`.

### Result of 136-2

The owner checked on 16 November 2026 on an iPhone 17 Pro with iOS 27.2.1.
The development stack ran through ngrok, as in 136-1.

#### What was built

- Server address screen: `ios/chalk/ServerScreen.swift`, `ios/chalk/AppModel.swift`, and `ios/chalk/ContentView.swift`.
  The app shows it on first use.
- Address rule: `ios/chalk/ServerAddress.swift` ports `normalizeServerURL` (`desktop/src/config.ts:62-79`).
  - A bare host gets `https://`.
  - The rule drops the path, the query, and the fragment.
  - The rule refuses credentials.
  - The rule lowercases the host and drops the default port.
  - The app stores `origin/` in `UserDefaults`.
  - The app does not probe if the address is a chalk server, as the desktop app does not.
- If the main page fails to load, the app returns to the screen.
  The screen shows "Could not reach <host> (<reason>)", and the field holds the last server.
- Navigation rule: `ios/chalk/LinkRule.swift` ports `classifyLink` (`desktop/src/links.ts:23-37`).
  - A same-origin link stays in the app.
  - Other http and https links and `mailto` links open in Safari.
  - `about:blank` opens a child window.
  - The rule denies all other links.
- `ios/chalk/ChalkWebView.swift` applies the rule to main-frame navigations and to new-window requests (`target=_blank` and `window.open`).
  Subframe navigations are allowed, as in the desktop app, where `will-navigate` sees only the main frame.
  A same-origin link that asks for a new window loads in the main web view.
- Child windows: an `about:blank` window opens in a sheet with a **Close** button.
  The recovery-phrase print window and the call pop-outs are such windows.
  `window.close()` dismisses the sheet.
- Downloads: a blob `<a download>` link, a response marked as attachment, and a response of a type that the web view cannot show become a `WKDownload`.
  The file goes to a temporary folder, and the share sheet opens. The user can choose **Save to Files** there.
- Safe areas: the web view extends under the notch and the home indicator.
  The scroll view adds no inset, because the page uses `viewport-fit=cover` and `env(safe-area-inset-*)`.
- The media grant compares the full origin (scheme, host, and port) with the server origin.
  The page reloads if its web content process ends.
  The shell is still inspectable.
- App icon: a 1024 by 1024 opaque PNG in `ios/chalk/Assets.xcassets/AppIcon.appiconset/`.
  A new target in `web/icons/gen-png.mjs` renders it from `web/icons/favicon.svg` on the plate colour of the apple-touch icon.
  The tool now takes optional file names and renders only the matching targets, so `node icons/gen-png.mjs AppIcon.png` does not render the committed web PNGs again.

#### Decisions

- The app accepts https only.
  It refuses plain http, also for loopback hosts, and has no equivalent of the desktop `--insecure` flag.
  The session cookie is `Secure`, and a phone cannot reach a loopback development stack.
- To change the server later, the user turns on **Choose server on next launch** in the iOS Settings (`ios/chalk/Settings.bundle`, key `choose_server`).
  The app reads the toggle when it starts and each time it returns to the foreground.
  If the toggle is on, the app clears it and shows the server screen.
  The owner chose this over a gesture and over a screen only after a load failure.

#### Tests

The new Swift Testing target `chalkTests` has 10 tests in two suites (`ios/chalkTests/RulesTests.swift`).
The tests mirror `desktop/src/config.test.ts` and `desktop/src/links.test.ts`, and add the https-only rule.
All pass.
Run them on the Mac over SSH:

```
xcodebuild test -project chalk.xcodeproj -scheme chalk -destination 'platform=iOS Simulator,id=<sim>'
```

The owner made the target in Xcode, because a new target needs the graphical interface.
A source file in a synchronized folder needs no project edit.

#### Build loop

Device installs stay on **Run** in Xcode.
Signing over SSH fails, because the login keychain is locked in an SSH session ("User interaction is not allowed").
It fails also after `set-key-partition-list`.
A separate build keychain was considered and is deferred.
Builds and tests for the simulator run over SSH.

#### Device check

These checks passed:

- The server screen accepted a bare host, and the page loaded after the ngrok warning page.
- The safe areas look right. This is a visual check, not a measurement.
- An external link in a message opened in Safari, and chalk stayed open.
- An attachment download opened the share sheet.
- The app icon shows on the home screen.

#### Follow-up of 136-2

The owner made two changes on 16 November 2026, after the 136-2 commit.

- The server screen (`ios/chalk/ServerScreen.swift`) uses the look of chalk, because the owner asked for chalk's green.
  - The ground is `#050805`. The card is `#0a110b` with a 1 px `#24f077` border.
  - The text is monospaced. The system monospaced design stands in for Hack.
  - The label colour is `#74b08a`. The input text is `#24f077`, and its border is `#143a25`. The border turns `#24f077` on focus.
  - The error box is `#ff5252`.
  - The `connect` button has the style of `.chalk-auth-button`.
  - The screen scrolls and dismisses the keyboard when scrolled.
- The web view in `ios/chalk/ContentView.swift` ignores only the container safe area (`.ignoresSafeArea(.container)`).
  In 136-2 it used `.ignoresSafeArea()`, which includes the keyboard area. SwiftUI then did not shrink the web view above the keyboard.
  Together with the web bug of [135-10](PHASE-135-PHONE.md), this covered the sign-up fields in the shell.
  The page still extends under the notch and the home indicator.

The owner has not checked these two changes on the device. Check that the server screen shows the new look, and that the keyboard does not cover a field in the server screen or in sign-up.

#### Open checklist

These checks are not done:

- The Settings toggle brings back the server screen with the last server in the field.
  A plain http address shows a refusal message on the device.
  The Swift tests already cover the rule.
- The recovery-phrase print window opens in the sheet and **Close** works.
  Unknown: if `window.print()` shows the print dialog in `WKWebView` on iOS.

### 136-3 the page knows the shell

The shell marks itself, with a user agent suffix or a script message handler.
The page then hides the background notice in `web/src/components/PhoneCallSheet.tsx` and the Home Screen hint in `web/src/components/PushSettings.tsx`.
Today `pushSupported` in `web/src/notify/push.ts` decides if push is offered.
`pushSupported` is expected to be false in the shell, because `PushManager` is absent.
This is not yet verified in the code.
The Home Screen hint in `web/src/components/PushSettings.tsx` still needs to be hidden in the shell.
If the socket closes in the background, this slice defines the fix.
A grace period on the server is a possible fix and needs its own decision.
The slice also handles an incoming phone call.
The owner wants this: when a phone call comes in, chalk mutes the microphone and turns the camera off.
Then the user does not return live.
Two signals are candidates.
Check them before the slice is scoped:

- Web only: WebKit possibly fires a `mute` event on the microphone track when the phone call takes the audio.
  This works in the Home Screen web app too.
  It is unverified.
  Check this signal first.
- Native: the shell watches calls with `CXCallObserver` and tells the page.
  The shell only observes and is not a CallKit provider, so the rejected CallKit conflict does not apply.
  The page sets its own mute, so the decision stays in the page.

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

Slice 136-1 is the first built slice.
The shell text is now in [threat-model.md](../threat-model.md), section "The iOS shell (phase 136)".
The list below is the design draft. The items about APNs and passkeys wait for 136-4 and 136-2.

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
- Background capture in the shell: works for app switch and screen lock on iOS 27.2.1. Measured in 136-1, including a 5-min run of each.
- Background capture in the Home Screen web app: unmeasured.
- `Notification` and `PushManager` in the shell: absent (see "Page facts").
- Passkey sign-in in the shell: untried (see "Open measurement").
- The iOS versions that matter: only iOS 27.2.1 was tested.

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

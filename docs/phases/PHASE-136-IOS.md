# Phase 136 — ios: a wrapper app that keeps a call running in the background

A plan for a small iPhone app that wraps the chalk web page.
The goal is that a voice call continues when the user switches apps or locks the screen.
The design was written on 14 November 2026.

**Status: in progress.** Slice 136-1 is built and measured on a device (2026-11-16). The gate passed. Slice 136-2 is built and checked on a device (2026-11-16), with two checks open. A follow-up of 136-2 has a device check open. Slice 136-4 is split into four parts. Parts 136-4a, 136-4b, and 136-4c are built (2026-11-16). Part 136-4d is built in parts 1, 2, and 3. Part 3 is checked on a device. Slice 136-3 is built and checked on a device (2026-11-16), with two details open. Slice 136-5a is built (2026-11-16). Slice 136-5b: first upload done (2026-11-16), internal TestFlight test open. Slices 136-5c and 136-6 are not started.
**Tag:** `#ios` → `tools/where.sh -g ios` (this file and the `ios/` directory).

Decisions from the owner:

- The owner has a Mac. The owner decided on 16 November 2026 to buy a paid Apple Developer account. The account is active, and the project has its team id. Slices 136-4a to 136-4c, parts 1 and 2 of 136-4d, and 136-5a need no account. Part 3 of 136-4d used it and ran on a real iPhone on 16 November 2026. Only 136-5b, 136-5c, and the production APNs key still need it.
- The app is for the owner and the users of the owner's server. It is not a public App Store listing.
- Push in the shell: chalkd gets a native APNs sender, and Apple sees only ciphertext (decision of 16 November 2026). See 136-4.
- Distribution: TestFlight with a public link for the users of the owner's server (decision of 16 November 2026). See 136-5.

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

Slices 136-1, 136-2, and 136-3 are built, and 136-4a, 136-4b, and 136-4c are built. The other slices and parts are not started.

| Slice | Content | Status |
| --- | --- | --- |
| 136-1 | Device test, the gate for the phase. See below. | done, 2026-11-16 |
| 136-2 | The shell: server address screen, navigation rule, permission grant, safe areas, file download, app icon. | built, 2026-11-16. Open: the Settings toggle and the print window. See below. |
| 136-3 | The web client knows the shell, and mutes on a phone call. See below. | built and checked on a device, 2026-11-16. Checks (d) and (e) open. |
| 136-4 | Notifications in the shell: an APNs sender in chalkd. Four parts. See below. | 136-4a, 136-4b, and 136-4c built, 2026-11-16. 136-4d parts 1, 2, and 3 built, 2026-11-16. Part 3 is checked on a device. |
| 136-4a | APNs sender package, provider token, config parsing. No account needed. | built, 2026-11-16 |
| 136-4b | Device rows, a sealed WebSocket frame, fan-out from the dispatcher, chalkd builds the sender. No account needed. | built, 2026-11-16 |
| 136-4c | chalkctl support for the key, and the `docs/deployment.md` env table. No account needed. | built, 2026-11-16 |
| 136-4d | Shell registration, the bridge, the extension, the tap, a device test. Part 1 needs no account. Parts 1 and 2 need no account. The rest needs the paid account. | parts 1, 2, and 3 built, 2026-11-16. Part 3 checked on a device. |
| 136-5 | Distribution through TestFlight. Three parts. See below. | 136-5a built, 2026-11-16. 136-5b: first upload done. The internal TestFlight test is open. 136-5c not started. |
| 136-5a | Release preparation: Web Inspector in Debug only, deployment target 17.0, ignore rules, a CI job for the Swift tests, the export compliance record. No account needed. | built, 2026-11-16 |
| 136-5b | The first upload to App Store Connect from the Mac of the owner. Needs the paid account. | first upload done. The internal TestFlight test is open. |
| 136-5c | A GitHub release job that uploads each tagged build. Needs the paid account. | not started |
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
  Slice 136-3 adds an explicit mark.

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

The shell marks itself, and the page changes two hints and reacts to a phone call.

#### Decisions

- The mark is a user script, not a user agent suffix and not a script message handler.
  The script defines `window.chalkIOS = { shell: "chalk-ios/<version>", platform: "ios" }`.
  The property is frozen and not configurable.
  The version comes from `CFBundleShortVersionString`, and only letters, digits, and dots stay, so the version cannot end the string.
- The script runs at document start, in the main frame only.
  It runs before any page script, so a check at module load sees the mark.
  The page reads the mark by its shape: a string `shell` that starts with "chalk-ios/".
  The desktop app uses the same pattern with `window.chalkDesktop` (see `PHASE-104-DESKTOP.md`).
- The content security policy of the page has `script-src 'self'`.
  Native injection is not a page script, so the policy is expected not to apply.
  The device check showed this for the user script (see the result of 136-3).
- The call note "the call pauses while chalk is in the background" is hidden in the shell.
  Slice 136-1 measured that the call continues in the background there.
- The push settings have a new state, "ios-app".
  `pushAvailability` returns it right after "server-off" and before "ios-home-screen".
  The page shows "push notifications in the app are not available yet."
  `pushSupported` is false in the shell, because `PushManager` is absent, but the explicit state does not depend on it.
  Slice 136-4d replaces the text with the real toggle.
- The socket needs no grace period.
  Slice 136-1 measured that the WebSocket stays connected in the background in the shell.
  The server grace period that this section reserved is not needed.
  Keep it as a note: if a later device test shows a closed socket, the fix needs its own decision.

#### Phone call: mute and camera off

The owner's idea: when a phone call takes the microphone, chalk mutes it and turns the camera off.
Then the user does not return live.

- The rule only turns things off.
  `interruptPlan(inCall, muted, camOn)` in `web/src/voice/phone-call.ts` returns `{ mute: !muted, camOff: camOn }` in a call, and nothing outside a call.
- `VoiceSessionImpl.interrupt()` applies the plan with the same calls as the buttons: `call.setAudioState`, `call.setVideoEnabled(false)`, and `setGlobal`.
  The state is saved like a click.
- Nothing turns on when the phone call ends. The user unmutes.
- The user's own unmute wins, because `interrupt` runs only on a new signal.

There are two signals.

- Signal 1, the shell.
  A `CXCallObserver` in the coordinator of the main web view watches calls.
  It is an observer and not a CallKit provider, so the conflict in "Rejected" does not apply.
  It sees cellular calls, FaceTime calls, and other CallKit calls.
  When a call connects, the shell dispatches the window event `chalk-ios-phone-call` once for that call.
  `web/src/voice/session.ts` installs the listener at module load, and the listener runs `interrupt`.
  `PhoneCallTracker` in `ios/chalk/PhoneCallTracker.swift` makes the once-per-call rule. A ringing or declined call tells nothing.
- Signal 2, the page.
  It works on the web too, in Safari and in the Home Screen web app.
  `MicChain.watchInterruption` listens for `mute` on each raw microphone track, and again after a device swap.
  When the system mutes the current track, the chain calls `onInterrupted`.
  `call.ts` passes it to `onMicInterrupted`, also on the path that adopts parked media, and `detachMedia` clears it.
  `session.ts` maps it to `interrupt`.
  Unknown: if WebKit fires `mute` for a phone call.
  If capture falls back to the raw stream without the mic graph, this signal is absent.

### Result of 136-3

The code is built and tested.
The owner ran the device check on 16 November 2026.
The device was an iPhone 17 Pro with iOS 27.2.1.
The shell came from the working tree, and the dev stack ran through ngrok as in 136-1.
Checks (a), (b), (c), and (f) passed. Checks (d) and (e) are open.

#### Tests

- Web: 2045 of 2045 pass.
  New: `web/src/ios-shell.test.ts` (2 tests), a case in `push.test.ts` (the env helper has `iosShell`), and `interruptPlan` in `phone-call.test.ts`.
- Swift: 16 of 16 pass on the simulator.
  New: `PhoneCallTrackerTests` (3) and `ShellMarkTests` (3) in `ios/chalkTests/RulesTests.swift`.
- The full Go suite passes. This slice has no Go change.

#### Device checklist

- (a) Passed. The mark is present. In Safari Web Inspector on the Mac, `window.chalkIOS` printed `{shell: "chalk-ios/1.0", platform: "ios"}`.
  The user script ran under the content security policy of the page.
  The test that overwrites the mark was not reported.
- (b) Passed. In a call, the call note is gone. The push settings show the in-app text.
- (c) Passed. A phone call during a chalk call muted the microphone and turned the camera off.
  After the phone call, the user stayed muted.
- (d) Open, as a detail. Unknown: if the page script runs while the phone call holds the audio, or only when the user returns.
  The result of (c) holds in both cases. It was not measured separately.
- (e) Open. Not tested: if WebKit fires `mute` for signal 2, also in Safari.
  The owner accepts this.
  Unknown: which of the two signals caused the mute in (c), because both are active in the app.
- (f) Passed. `CXCallObserver` needs no entry in `Info.plist`.
  The build has no new `Info.plist` key, and the observer worked in (c).

### 136-4 notifications

A web view app has no web push, so phase 65 ([PHASE-65-PUSH.md](PHASE-65-PUSH.md)) does not work inside it.
136-1 measured this: `PushManager` and `Notification` are absent in the shell.

#### Decision

The owner decided on 16 November 2026 to build a native Apple Push Notification service (APNs) sender in chalkd.
Apple may see only ciphertext.

- The app makes its own P-256 key pair and a 16-byte authentication secret.
  It uploads the public key and the secret with the APNs device token, in the same shape as a Web Push subscription.
- chalkd encrypts the push payload with the code of phase 65 (RFC 8291, `aes128gcm`, padded to one fixed length).
  It sends the ciphertext through APNs.
- A Notification Service Extension in the app decrypts the ciphertext and fills in the notification.
- If the extension fails, the phone shows a constant fallback text.
  The text is "chalk" and "New notification".

Rejected:

- Plain metadata in the push.
  Apple could read the sender handle and the channel name.
- Generic text only, with no extension.
  Apple sees nothing, but the notification is the least useful.
- No push in the shell.

Rules that stay the same as Web Push (phase 65):

- Push is opt-in per device.
- The scope is direct messages or all messages.
- A user gets at most one message push per channel in 60 s.
- Guests get no push.
- A subscription is bound to the login session.
- The frames go only on the sealed WebSocket.

Consequence: only a server that holds the `.p8` key of the developer team of the app can push to the app.
Another chalk server that a user enters on the server screen gets no native push.

#### Parts

| Part | Content | Needs the account | Status |
| --- | --- | --- | --- |
| 136-4a | APNs sender package, provider token, config parsing. | no | built, 2026-11-16 |
| 136-4b | Device rows (a migration). A sealed WebSocket frame that carries the device token, the public key, and the authentication secret. Fan-out to both senders from the dispatcher, reminders included. chalkd builds the sender at start. | no | built, 2026-11-16 |
| 136-4c | chalkctl: set the key that the operator supplies, keep it on `--force`, backfill it on `update`, and carry it on restore. The env table in `docs/deployment.md`. | no | built, 2026-11-16 |
| 136-4d | Shell: registration for remote notifications, and a bridge that hands the token and the key to the page. The extension that decrypts. A tap that opens the channel. A device test. The bridge and the page (part 2) need no account. The Push capability, an app group, and an extension target need it. | parts 1 and 2 no, the rest yes | parts 1, 2, and 3 built, 2026-11-16. Part 3 checked on a device. |

The env table in `docs/deployment.md` lists the variables since 136-4c.

#### Result of 136-4a

Built on 16 November 2026.
The code is in the new package `internal/apns/` (`apns.go`, `apns_test.go`).
It uses only the Go standard library and the existing code of chalk, so it adds no module.

- `ParseKey(p8, keyID, teamID)` reads the `.p8` key of Apple.
  The key can be PEM or the bare base64 of its body, so it fits on one line of an environment file.
  The key must be a PKCS#8 P-256 key.
  The key id and the team id are each 10 letters and digits.
- The provider token is an ES256 JWT with the header fields `alg` and `kid` and the claims `iss` (the team id) and `iat`.
  The key caches the token and renews it after 40 minutes.
  Apple rejects a token that is older than one hour, and asks providers not to make a new token more often than every 20 minutes.
  If APNs answers 403 with `ExpiredProviderToken`, the key drops the cached token, so the next send signs a new one.
  A clock that went back also gives a new token.
- `Sender.Send(ctx, Device{Token, P256dh, Auth}, payload, Options{TTL, CollapseID, Priority})` does these steps:
  1. It checks the device token. The token must be hexadecimal and at most 200 characters, so it cannot change the request path.
  2. It encrypts the payload with `webpush.Encrypt`.
  3. It posts to `/3/device/<token>` on `api.push.apple.com` (production) or `api.sandbox.push.apple.com` (sandbox).
     Builds that Xcode installs use the sandbox. TestFlight builds use production.
- The headers are `authorization: bearer <token>`, `apns-topic` (the bundle id), `apns-push-type: alert`, `apns-priority`, `apns-expiration`, and `apns-collapse-id` if set.
  The priority is 10 by default and 5 for `PriorityNormal`.
  The expiration is the time now plus the TTL as Unix time, or 0 if the TTL is zero.
  A collapse id of more than 64 bytes gives `ErrCollapseID`.
- The JSON body has exactly two keys.
  - `aps` holds the constant fallback alert, `mutable-content: 1` (this makes iOS run the extension), and `sound: default`.
  - `chalk` holds the base64 of the RFC 8291 ciphertext.
  The ciphertext has one length, so every body has one length, well under the APNs limit of 4096 bytes.
  The body has no badge count in clear text. The count is inside the ciphertext, and the extension sets it.
- The answers:
  - Status 200 is a success.
  - Status 410, and status 400 with the reason `BadDeviceToken` or `DeviceTokenNotForTopic`, wrap `ErrGone`. The caller removes the row. The error text keeps the status and the reason.
  - Every other answer is a `*StatusError` with the code, `RetryAfter`, and the reason. The reason goes through `webpush.ReasonFrom`, so text of a third party cannot add a line to the log.
  - Nothing is retried, as in Web Push.
- `BadDeviceToken` is also the answer when a sandbox token goes to the production host.
  A wrong `CHALK_APNS_ENV` therefore makes the caller remove rows.
  The app uploads its token again at its next reconcile (136-4b and 136-4d).
- `internal/webpush/send.go`: the guarded HTTP client moved out of `NewSender` into `newClient` and `newTransport`.
  The new `NewHTTP2Client(timeout, opts...)` returns the same client with `ForceAttemptHTTP2`.
  The client connects only to public addresses, uses no proxy, follows no redirect, and honors `WithIPv4Only`.
  Go turns HTTP/2 off for a transport with a custom dial function, and APNs speaks only HTTP/2.
  The Web Push sender keeps HTTP/1.1.
  `ReasonFrom` is the new exported form of `reasonFrom`.
  `internal/webpush/http2_test.go` shows that the transport speaks HTTP/2 to a TLS test server with the flag and HTTP/1.1 without it.
- `internal/config/push.go`: `PushConfig.APNs` (`APNsConfig`) reads these variables:

  | Variable | Value |
  | --- | --- |
  | `CHALK_APNS_KEY` | The `.p8` key, as PEM or bare base64. |
  | `CHALK_APNS_KEY_ID` | The key id. |
  | `CHALK_APNS_TEAM_ID` | The team id. |
  | `CHALK_APNS_TOPIC` | The bundle id of the app. It is `at.73c.chalk` for the build of the owner. |
  | `CHALK_APNS_ENV` | `production` (default) or `sandbox`. |

  The key, the key id, the team id, and the topic must all be set, or none of them.
  The code checks the values only if `CHALK_PUSH_ENABLED=true`, as it does for the VAPID values.

#### Limits of 136-4a

- chalkd does not build or use the sender yet.
  The variables have no effect, and no push goes to Apple.
- chalkctl did not know the variables in 136-4a.
  136-4c closed this (see "Result of 136-4c").
- Nothing was sent to the real APNs.
  The tests use a local TLS test server.
- Verification: `go test ./internal/apns/ ./internal/webpush/ ./internal/config/` passes.

#### Result of 136-4b

Built on 16 November 2026.
chalkd can now store the registration of an app install and send a push to it.
No client sends the registration yet, so no user gets a native push (see "Limits of 136-4b").

Design: one table with a `kind` column.
Migration `0066_push_subscription_kind.sql` adds `kind` to `push_subscriptions`.
The value is `webpush` (the default) or `apns`.
Rows from before the migration become `webpush`.
An APNs device is one row:

| Column | Content for an APNs row |
| --- | --- |
| `endpoint` | The device token, in lowercase hexadecimal. |
| `p256dh` | The public key that the app made for itself (65 bytes). |
| `auth` | The authentication secret that the app made for itself (16 bytes). |
| `vapid_key` | The APNs subscription key, `<bundle id>/<environment>`. |

The rows go in the same table because the payload has the same shape as a Web Push subscription.
The rules of phase 65 therefore cover APNs rows with no new code:

- The row belongs to the login session and ends with it.
- A session has one subscription, of either kind.
- A user has at most 8 subscriptions, and the oldest goes first.
- Guests have no grant.
- The unsubscribe frame deletes the row.
- The reminder-wake trigger of migration 0065 counts rows of both kinds.

Rejected: a second table for APNs devices.
It needs a second copy of the cap, the eviction, the session binding, and the trigger.

`internal/store/push.go`:

- `PushKind` has the values `PushKindWebPush` and `PushKindAPNs`.
  `PushSubscription.Kind` and `pushCols` carry it.
- `UpsertPushSubscription` takes the kind after the session token.
  It refuses an unknown kind.
- `ListPushSubscriptionsForUsers` takes a list of keys (`vapid_key = ANY($4)`) in place of one key.
  An empty list returns nothing.
  A VAPID public key is base64url and never holds `/`.
  An APNs key always holds `/`.
  One query therefore returns the web push rows of the current VAPID key and the APNs rows of the current topic and environment.
  Rows of an old key of either kind are left out.

Frames (`internal/proto/push.go`, `internal/server/push_ws.go`):

- `push_subscribe_apns` and `push_subscribe_apns_ack`.
  The payload is `PushSubscribeAPNsPayload` with `token`, `p256dh`, `auth` (both base64url), `scope`, `topic`, and `environment`.
- The gates are the same as for `push_subscribe`: a sealed channel, a login session, and no guest.
  The guest allowlist does not hold the frame.
- If push is off or the server has no APNs sender, the answer is `push_disabled`.
- `parsePushSubscribeAPNs` checks the topic and the environment first.
  A difference gives the new error code `push_apns_mismatch`.
  It means that the app has another bundle id, or that a sandbox build talks to a production server.
  Then it checks the token (`apns.ValidateToken`), the P-256 point, the 16-byte auth secret, and the scope.
  The server stores the token in lowercase.
- `PushStatePayload` has three new fields.
  `apns_topic` and `apns_environment` are empty if the server has no APNs sender or push is off.
  This is how the page learns that native push is available.
  `kind` is the kind of the subscription of the session.
  `key_current` of an APNs row compares the row with the key of the sender.

Dispatcher (`internal/server/push_dispatch.go`, `reminder_push.go`):

- The interface `apnsSender` has `Send`, `Topic`, `Environment`, and `Key`.
  `pushDispatcher.apns` is nil if APNs is off.
- `keys()` returns the VAPID key, and the APNs key if APNs is on.
  The dispatcher and the reminder sweep list rows with it.
- `send` picks the sender by `sub.Kind`.
- An APNs row while APNs is off is skipped.
  It is not sent, not deleted, and not touched.
  A server that drops its APNs settings therefore keeps the rows until the sessions end.
- `apns.ErrGone` deletes the row, as `webpush.ErrGone` does.
  Another error only logs.
- `nativeOptions` maps the web push options.
  The TTL stays, the priority is always high (10), and there is no collapse id.
- Every device of a user, web or native, gets the same payload bytes.
  One cooldown covers all devices: one push per user and channel in 60 s.

chalkd (`cmd/chalkd/main.go`, `internal/server/server.go`):

- chalkd builds the sender if `CHALK_PUSH_ENABLED=true` and the `CHALK_APNS_*` values are set.
  It uses the same IPv4-only option and the same send timeout as web push.
- The log line is `push: apns enabled (topic=... environment=...)` or `push: apns disabled (CHALK_APNS_* unset)`.
- `Options.APNs` goes to the dispatcher and to the WebSocket handler only if it is not nil and web push is on.
  The guard avoids a typed nil in the interface.
- `internal/apns` gained `Sender.Environment()`, `Sender.Key()`, and `SubscriptionKey(topic, env)`.

What Apple gets for each push:

- The device token, in the request path.
- The bundle id, in `apns-topic`.
- The provider token, which names the team id and the key id.
- A body with the constant alert text and one ciphertext of one fixed length.
  RFC 8291 encrypts it with the same code as web push, to the key pair of the app.
  Apple has no key.
- Headers that are constant: push type `alert`, priority 10, expiration now plus 24 h, and no collapse id.
  No header names a channel or a sender.

The threat model has the full list ("Third parties: APNs (phase 136)").

Tests:

- `internal/server/push_apns_test.go` has 8 tests for these cases:

  1. A dispatch to both kinds with the same payload.
  2. The cooldown across devices.
  3. The prune on `apns.ErrGone`.
  4. APNs rows without a sender.
  5. Reminders to APNs.
  6. The parse cases.
  7. The push state.
  8. The guest fence.

- `internal/store/push_test.go` has the new subtest "an APNs device is listed only under its own key".
- The fakes in `push_dispatch_test.go` and `reminder_push_test.go` take a list of keys.

#### Limits of 136-4b

- chalkctl did not know `CHALK_APNS_*` in 136-4b.
  136-4c closed this (see "Result of 136-4c").
- The page and the app did not send `push_subscribe_apns` in 136-4b.
  136-4d part 2 added the sender, but no user gets a native push before the extension exists (see "Result of 136-4d, part 2").
- Nothing was sent to the real APNs, and no chalkd ran with APNs settings.
- Verification: `go test ./...` passes.
  The store tests pass with `CHALK_TEST_PGURL` set to the dev Postgres, in a scratch database with all migrations.
  `test/integration` was not run, because its fixtures are not seeded on the dev database.

#### Result of 136-4c

chalkctl stores the APNs key that the operator supplies. No account is needed, and no real Apple key was used.
The tests make P-256 keys.

- `internal/chalkctl/apns.go` is new.
  `chalkctl push apns set --key-file F --key-id K --team-id T --topic B [--sandbox]` reads the `.p8` file and checks the key and the ids with the parsers of `internal/apns`.
  It writes the five `CHALK_APNS_*` values into `chalk.env` and restarts chalkd.
  It replaces a line that exists, appends a line that is absent, and leaves other lines alone.
  It never prints the key.
- The key goes into the env file as one base64 line, which is the DER of the PEM body.
  Bare base64 is also accepted, and its line breaks are removed.
  A key file larger than 16 KiB is refused.
- `set` writes nothing to the chalkctl config file, because the key is a secret and the config file is not.
- If a check fails, `set` changes nothing and does not restart chalkd.
- If push is off, `set` says so and names `chalkctl push enable`.
  It also says that the key file can be deleted, because `chalk.env` holds the key.
- `chalkctl push apns clear --yes` empties the five values and restarts chalkd.
  It refuses without `--yes`, because native push to every iOS app of the server stops.
- `chalkctl push status` has a new `apns:` line.
  It shows `set (topic=... environment=... key id=...)`, `not set`, or `INCOMPLETE`.
  With push on and an incomplete set, chalkd does not start (`config.Validate`, 136-4a).
- Restore carries a complete set from the archive into the env file of the new host (`carryAPNs`).
  An incomplete set is not carried, and restore logs it.
  The device rows in the restored dump are bound to the topic and the environment, and the key cannot be made again.
- `init --force`, with or without `--drop-db`, renders `chalk.env` from the template again.
  `keepAPNs` reads a complete set from the old env file, so the new file keeps it.
  An incomplete set is dropped with a warning.
  The template writes the APNs block only if the key is set, so a fresh `init` has no APNs lines.
- `update` needed no change.
  It appends missing lines and never removes or rewrites a line, so the APNs lines survive it.

The repo rule for a server variable is "generated fresh, preserved on `--force`, backfilled on `update`".
It maps to the APNs values like this:

| Rule | APNs values |
| --- | --- |
| Generated fresh | Not generated. The operator supplies the key with `push apns set`, because it comes from Apple. |
| Preserved on `--force` | `keepAPNs`. |
| Backfilled on `update` | Not applicable. `update` keeps the lines, and no value can be backfilled. |

`cmd/chalkctl/main.go`: `runPush` accepts `apns set` and `apns clear`, with the flags `--key-file`, `--key-id`, `--team-id`, `--topic`, and `--sandbox`.
The help text lists the commands.
The env table and a section "Native push to the iOS app" are in `docs/deployment.md`.

Tests: `internal/chalkctl/apns_test.go` checks the key line, `set`, the push-off note, the refusals, `clear`, the status line, the restore carry, and `init --force`.
chalkctl has no full init harness, so the last test renders the template from the output of `keepAPNs`.

Limits of 136-4c:

- No real chalkctl ran as root, and no real Apple key was used.
- Verification: `go test ./internal/chalkctl/` passes.

#### Result of 136-4d, part 1

Part 1 is the receiver side of the push crypto and the payload text. No account is needed, and the Swift tests run on the simulator.

- `ios/chalk/PushCrypto.swift` is new.
  `PushCrypto.decrypt(body, privateKey, auth)` is the receiver side of RFC 8291 (`aes128gcm`, one record) with CryptoKit only.
  It reads the header (salt, `rs`, key id length, sender key) and does the P-256 ECDH.
  It derives the key and the nonce with HKDF-SHA256.
  It opens the record with AES-128-GCM, removes the zero padding, and requires the `0x02` delimiter of the last record.
  It is the counterpart of `internal/webpush/encrypt.go`, which chalkd uses for web push and for APNs.
- The errors are `tooShort`, `header`, `key`, `open`, and `delimiter`.
  `header` means a key id length not 65, a record longer than `rs`, or `rs` less than 18.
  `key` means a sender point that is not valid.
  `open` means a wrong key, a wrong auth secret, or a changed byte.
- `ios/chalk/PushContent.swift` is new.
  `PushContent.from(payload:)` turns the decrypted JSON into a title, a body, a thread id, a badge, and the open target (channel, thread, or reminder).
  The thread id groups notifications like the tag of a web notification.
  The wording is the same as `notificationFor` in `web/src/sw-logic.ts`.
  The texts are "@alice in #general", "@bob" for a direct message, "someone", "New message", "New reply in a thread", and "Reminder: a message is due".
  An unknown or malformed payload gives `PushContent.fallback`, with the title "chalk" and the body "New notification".
  This is the same constant text that chalkd puts in the APNs alert (`internal/apns`).
- Channel, message, thread, and reminder ids must be UUIDs.
  This is stricter than the web, because the extension builds the address that it opens from them.
- `ios/chalkTests/PushTests.swift` is new.
  The RFC 8291 Appendix A vector decrypts to "When I grow up, I want to be a watermelon".
  The test checks first that the receiver key derives the public key of the RFC.
  A padded push like the one from chalkd round-trips through a test-only sender.
  The plaintext has 1024 bytes, and the body has 21 + 65 + 1024 + 16 bytes.
  The tests refuse each of these cases:
  a changed byte, a wrong key, a wrong auth secret, a short body, and a missing delimiter.
  They also refuse a bad key id length and a bad sender point.
  The content cases cover a channel message, a direct message, a thread reply, a reminder, and the fallback.
- The Swift tests pass on the simulator: 23 of 23.

Not done in part 1, because it needs the paid account:

- The Notification Service Extension target.
- The app group and the keychain sharing for the key pair.
- The registration for remote notifications.
- The bridge from the shell to the page.
- The page that sends `push_subscribe_apns`.
- The open on a tap.

#### Result of 136-4d, part 2

Part 2 is the bridge between the shell and the page.
It needs no account.
Without the Push capability, iOS refuses the registration, and the app answers "unavailable".
A server without `CHALK_APNS_*` still shows "push notifications in the app are not available yet.", as before.

The message format:

- The app adds a WebKit reply handler named `chalkPush` in the page content world.
  The page posts `{op: "register", prompt}`.
  If `prompt` is true, the app shows the iOS permission prompt, but only when the user has not decided yet.
- The reply is `{ok: true, token, p256dh, auth, topic, environment}` or `{ok: false, error: "denied" | "unavailable"}`.
  The token is lowercase hex.
  `p256dh` is the 65-byte public key and `auth` is the 16-byte secret, both in unpadded base64url.
  `topic` is the bundle identifier.
- `parseNativeReply` in `web/src/notify/ios-push.ts` checks the reply.
  The token must be hex of 200 characters or fewer.
  The key must be 65 bytes, the secret 16 bytes, and the topic not empty.
  The environment must be `production` or `sandbox`.
  Any other reply counts as "unavailable".
- `ios/chalk/PushRegistrar.swift` waits up to 15 seconds for the device token.
  A timeout gives "unavailable".

The page:

- `web/src/proto.ts` has the types of `push_subscribe_apns` and its ack, the error code `push_apns_mismatch`, and the fields `apns_topic`, `apns_environment`, and `kind` of `PushStatePayload`.
- `enableNativePush` asks the app with `prompt` true and then reads `push_state`.
  If the server offers no APNs, it fails with `push_disabled`.
  Otherwise it sends `push_subscribe_apns` and calls the `onPushSubscribed` listeners, which resend the reminder wake set (87-7).
  Its errors are `push_native_denied` and `push_native_unavailable`.
- In the app, `pushAvailability` returns "ios-app" until `push_state` has `apns_topic` and the bridge exists.
  Then it returns "ready", or "unsealed" without a sealed connection.
  `PushSettings` reads `push_state` also while the value is "ios-app".
  The switch and the scope select use `enableNativePush`.
  The switch off uses `disablePush`, which sends `push_unsubscribe`.
- `reconcileNativePush` runs after each welcome, beside `reconcilePush`.
  It acts only if this session has an APNs row, and it asks the app without a prompt.
  If the token changed or `key_current` is false, it uploads again, because Apple can change the token of a device.
  Part 3 changed this: it now always uploads again (see "Result of 136-4d, part 3").
  If the user turned notifications off in the iOS Settings app, it sends `push_unsubscribe`.
  If the app is "unavailable", it does nothing.
- The new error texts are `push_native_denied`, `push_native_unavailable`, and `push_apns_mismatch`.

The tap path:

- The notification extension is not built yet.
  It must write the keys `chalk_channel`, `chalk_thread`, and `chalk_reminder` into the `userInfo` of the notification.
  `PushOpen.target` reads them, and only UUIDs pass.
- `AppDelegate` sets the notification center delegate at launch, so that a tap that starts the app arrives.
  It shows no banner while the app is in front, because the page shows its own banners.
- `PushOpenRouter` keeps the target until the page has loaded.
  It then dispatches the `chalk-ios-open` event with `callAsyncJavaScript` and arguments, so the target is never part of the script text.
- `installIOSOpenListener` checks the event again with `openTargetFromIOS`, and `App.tsx` sends the target to `openFromNotification`, like a click on a web push.

The keys and their storage:

- `PushKeys.loadOrCreate` makes the P-256 key and the 16-byte secret once, with `SecRandomCopyBytes`, and keeps them.
  If the stored item is damaged, it makes new keys.
- The Keychain item is a generic password with the service `at.73c.chalk.push`.
  Its access is `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, because the extension must read it while the phone is locked after the first unlock.
  The item had no access group in part 2. Part 3 added the shared group (see "Result of 136-4d, part 3").
  The group comes with the extension and the app group, which need the account.
- The private key does not leave the Keychain.
  The page gets only the public key and the secret.

The environment depends on the build configuration.
A Debug build reports `sandbox`, and a Release build reports `production`.
Builds that run from Xcode use the APNs sandbox.
TestFlight and App Store builds use production.
chalkd answers a wrong value with `push_apns_mismatch`.

The origin check:

- `PushBridge` answers only the main frame of the server origin.
  It refuses any other frame with the error "refused".
- `originString` builds the origin.
  The media permission check uses it too.

Tests:

- `web/src/notify/ios-push.test.ts` has 5 tests, and `web/src/notify/push.test.ts` has a new test for the availability in the app.
  The web suite passes: 2051 of 2051.
- `PushBridgeTests` in `ios/chalkTests/PushTests.swift` has 4 tests.
  They cover keys made once, kept, and made again when damaged, the Keychain round trip on the simulator, the reply format, and the tap targets.
  The Swift tests pass: 27 of 27.
  The Release build compiles.

Not done in part 2, because it needs the paid account.
Part 3 built the items below. See "Result of 136-4d, part 3".

- The Push Notifications capability (the `aps-environment` entitlement).
- The Notification Service Extension target.
  It decrypts with `PushCrypto`, words the text with `PushContent`, and writes the `userInfo` keys.
- The app group, and the Keychain access group that the app shares with the extension.
- The device test.

#### Result of 136-4d, part 3

Part 3 is the notification service extension.
It needs the paid account, because it uses the Push capability and a shared Keychain access group.
The extension decrypts each push on the device and replaces the constant alert text of chalkd.

The extension:

- `ios/chalkPush/` is a new target with `NotificationService.swift`, an `Info.plist`, and `chalkPush.entitlements`.
- iOS runs it for each push with `mutable-content`.
  It first prepares the fallback content: the title "chalk", the body "New notification", and no badge change.
- It then reads the keys from the shared Keychain group.
  It decrypts the `chalk` field (RFC 8291, the same as web push) and words the text with `PushContent`.
  It replaces the title, the body, the thread, the badge, and the tap target with those of the payload.
- If any step fails, or if the time of the extension runs out, the notification shows the fallback text.
- The badge is the `unread` value of the payload.
  The server counts the unread direct messages and the pending friend requests, as for web push.
  A channel message therefore sends a badge of 0.

The shared code:

- `PushCrypto.swift`, `PushContent.swift`, and `PushKeys.swift` moved from `ios/chalk/` to `ios/PushShared/`.
  The app and the extension both build them.

The shared Keychain group:

- Both targets have the access group `$(AppIdentifierPrefix)at.73c.chalk.shared` in their entitlements.
  Both `Info.plist` files have the key `ChalkKeychainGroup` with the same value, and `KeychainStore.push` reads it.
- The item keeps the access class `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so the extension can read it while the phone is locked.
- The `Info.plist` of the app also has `ChalkLegacyKeychainGroup`.
  Its value is the default group of the app, where builds before the shared group saved the key.
- `PushKeys.loadOrCreate(store, legacy:)` moves a valid key from the legacy item into the shared group and then deletes the legacy item.
- `PushKeys.load` reads the keys and never makes them. The extension uses it.

Two bugs that the device test found, both fixed:

- The legacy store had no access group at first.
  A Keychain query without a group matches the items of every group that the app can reach.
  The delete of the legacy item therefore also deleted the item that the app had just moved.
  The legacy store now names its own group.
- The page compared only the token with the server row, so new keys on the device never reached the server.
  The server kept the old public key and encrypted to it, and the extension could not decrypt and showed the fallback.
  `planNativeReconcile` now always uploads the registration again, the token and the keys, after each welcome of a session with an APNs row.
  The rejected alternative, for now, is to compare the stored key.
  It needs the server to report the key that it holds.
  The upload costs one frame for each welcome.

The badge:

- The bridge has a second request, `{op: "badge", count}`.
  `PushBridge` sets the icon badge with `UNUserNotificationCenter.setBadgeCount`.
  `badgeCount(_:)` accepts an integer of 0 or more and limits it to `maxBadge` (9999).
  The page side is `nativeBadgeMessage`, `setNativeBadge`, and `MAX_NATIVE_BADGE` in `web/src/notify/ios-push.ts`.
- Before this, nothing in the app cleared the badge that a push set.
  The badge effect in `App.tsx` (50-7) now sends its count with `setNativeBadge`.
  The effect also runs when the page becomes visible.

Presence in the background:

- chalkd sends no push to a user who has any device online.
- `intendedPresence(mode, userIdle, hiddenInIOSApp)` in `web/src/presence/idle.ts` decides the presence.
  In the app, in the "auto" mode, the page claims "away" when it goes to the background and "online" when it comes back.
  A manual "online" or "away" mode wins.
- The rule stays per user.
  An online desktop still suppresses the push to the phone, so the user gets no double notification.
  The developer decided to keep this.

The page:

- `pushAvailability` checks the sealed connection before the bridge.
  The push settings in the app now show "push needs the sealed connection" and not "not available".

Tests:

- `PushKeyMigrationTests` and a `badgeCount` test in `ios/chalkTests/PushTests.swift`.
- New tests in `web/src/notify/ios-push.test.ts`, `web/src/presence/idle.test.ts`, and `web/src/notify/push.test.ts`.

Device test (16 November 2026, a real iPhone, the APNs sandbox, the dev server through a tunnel):

- The extension decrypts and shows the real title ("@" and the handle of the sender) and the body "New message".
- A direct message sets the badge to 1. The badge clears after the receiving user opens the chat and reads the message.
- A push arrives when the app is only in the background (the home gesture), and not only when the app is closed.
- A tap on the notification opens chalk on that direct message. This check passed.

Facts from the device test:

- While Xcode is attached to the app, a swipe that closes the app does not close its connection.
  The server then keeps the user "online" and sends no push.
  Press Stop in Xcode before the test.
- When the phone is locked, the notification shows only in the Notification Center. This is normal for iOS.
- A channel message sends a badge of 0, because the badge counts only direct messages and friend requests.

To find a fault in the extension:

1. Connect the phone to the Mac.
2. Open Console.app and select the device.
3. Filter the log for `chalkPush`.
4. Send a push and read the lines of the extension.

If the notification shows "New notification" and not the real text, the extension ran and used the fallback.

Open:

- A push through the production APNs key is not tested. The test used the sandbox.
- The comparison of the stored key (see above) is a follow-up.

### 136-5 distribution

Free signing expires after 7 days, so it served 136-1 only.
The owner decided on 16 November 2026 to distribute the app through TestFlight, with a public link for the users of the owner's server.
This needs the paid Apple Developer account, which is active.
The slice has three parts. Part a needs no account and is built.

| Part | Content | Needs the account | Status |
| --- | --- | --- | --- |
| 136-5a | Release preparation. | no | built, 2026-11-16 |
| 136-5b | The first upload from the Mac of the owner. | yes | first upload done. The internal TestFlight test is open. |
| 136-5c | A GitHub release job. | yes | not started |

On 16 November 2026 the owner decided: the first upload is done locally from the Mac, and the GitHub release job comes later.
The owner checked that the free macOS runners of GitHub offer Xcode 27.

#### Result of 136-5a

- Web Inspector is Debug only.
  `isInspectable = true` in `ios/chalk/ChalkWebView.swift` is inside `#if DEBUG`.
  The Release binary has no `setInspectable` selector, and the Debug binary has it.
  A TestFlight or App Store build cannot be inspected with Safari Web Inspector.
- The deployment target is 17.0 (`IPHONEOS_DEPLOYMENT_TARGET`, before 27.2).
  17.0 is the floor, because the app uses `@Observable`, `@Bindable`, and the two-parameter `onChange`, which need iOS 17.
  An unsigned Release build for devices succeeds, and its `MinimumOSVersion` is 17.0.
- Not measured: background audio, the marker, the call observer, and the rest on iOS 17 to 27.1.
  The checks of 136-1 and later ran on iOS 27.2.1 only.
  A device or a simulator with an older iOS must run the device checklists before the app is offered to users of those versions.
- `.gitignore` has the new entries `*.p8`, `*.p12`, `*.pfx`, `*.cer`, `*.mobileprovision`, and `*.provisionprofile`.
  `git check-ignore` matched an `AuthKey_*.p8` file in `ios/`.
- `.github/workflows/ci.yml` has a new job `ios` on `macos-latest`.
  The job has `continue-on-error: true`, so it never fails the workflow.
  Its first step selects the newest `/Applications/Xcode_27*.app` and writes a notice with the version.
  If the image has none, the step writes a warning and the tests do not run.
  If the image has no iPhone simulator, that is also a warning.
  Otherwise the job picks the first available iPhone simulator and runs `xcodebuild test -project chalk.xcodeproj -scheme chalk -destination id=... CODE_SIGNING_ALLOWED=NO` in `ios/`.
  It uses no secrets.
  Like every job in `ci.yml`, it runs only on manual dispatch (`workflow_dispatch`).
- The scheme is not in the repository.
  Xcode makes it with the test target, which is also how the local runs work.
  If the first GitHub run cannot find the scheme, share the scheme in the project.
- The same unsigned command passed on the Mac of the owner.
  The job itself has not run on GitHub.

#### Export compliance

Decision of the owner, 16 November 2026: answer 2, standard encryption algorithms in addition to those of the operating system.
`ios/Info.plist` has no encryption key. App Store Connect asks the encryption questions in the browser for each build. See "First upload failure" below.
This section is not legal advice. The facts below come from Apple and the US rules, as the owner described them.
Check each fact in App Store Connect when the question appears.

App Store Connect asks about encryption for every build, because `Info.plist` has no `ITSAppUsesNonExemptEncryption` key.
In TestFlight, a new build shows "Missing Compliance". Select **Manage** and answer the questions.
Answer 2, as decided.

What the app binary contains:

- In 136-1 to 136-3, no own crypto implementation. HTTPS goes through WebKit, which is part of the operating system.
- From 136-4d, the notification extension decrypts pushes with CryptoKit, which is part of the operating system.
  It uses P-256 ECDH, HKDF-SHA256, and AES-128-GCM.

What the web client does:

- The web client is downloaded from the server of the user at run time. It is not part of the binary.
- It uses AES-GCM, ECDH and X25519, Ed25519, HKDF, and SHA through WebCrypto, which WebKit provides, so the operating system provides it.
- It uses Argon2id through hash-wasm. This is WebAssembly. The algorithm is a standard one, and the operating system does not provide it.
- All algorithms are standard ones. Nothing is proprietary.
- The main purpose of the app is end-to-end encrypted chat.

#### First upload failure

The first upload of version 0.12.5 (build 1 or 2) failed on 16 November 2026 with this message:
"Invalid Export Compliance Code. The export compliance key value [] in the app's Info.plist doesn't match the key value of the app's export compliance documentation."

The cause: `ITSAppUsesNonExemptEncryption` set to `true` tells Apple that approved export compliance documentation exists.
Apple then requires `ITSEncryptionExportComplianceCode` with the code that App Store Connect issues after it approves that documentation.
The app has no such code.

The fix: the key `ITSAppUsesNonExemptEncryption` was removed from `ios/Info.plist`.
The decision of the owner did not change. Only the place of the answer changed, from `Info.plist` to the browser.
After the fix, the upload succeeded.

Follow-up, optional: submit App Encryption Documentation in App Store Connect (App Information).
If Apple approves it and issues a code, put both keys into `Info.plist`: `ITSAppUsesNonExemptEncryption` set to `true`, and `ITSEncryptionExportComplianceCode` with the code.
The per-build question then goes away.
Do not set `ITSAppUsesNonExemptEncryption` to `true` without the code.

The rejected option was answer 1: only encryption inside the operating system of Apple, or an exempt use.
It sets the key to `false` and needs no documents.

Open steps for the owner. Each one is a check, not a legal claim:

- For each build, App Store Connect asks the encryption questions in the browser. Answer them in line with the decision.
- The US export rules usually mean an annual self-classification report for mass-market encryption. Check what applies and when it is due.
- Apple can ask about distribution in France. Check that question when it comes.

#### Open decision: Beta App Review sign-in

The reviewer of Beta App Review must sign in to the app, and chalk asks for a TOTP code at every login.
These are the options:

- A review account on the server, with its TOTP secret in the review notes.
- A separate review server.

This decision blocks the external tester group. It does not block internal testing.

#### Version of the app

The owner decided on 16 November 2026 that a native app carries the chalk version in its own project file.
This breaks the rule of one version number in the repository.
The same rule applies to the native macOS app of phase 138 and to a possible Android app.

- `MARKETING_VERSION` of the targets `chalk` and `chalkPush` is `0.12.5`. The app and the extension must have the same version, or Apple warns.
- The target `chalkTests` stays at `1.0`, because it never ships.
- The owner edits the version by hand to the current chalk release before each upload to Apple.
- The app does not need a new version for each chalk release, because it only loads the web client from the server. A server update never needs a new app build.
- The app version records the chalk release at which the shell was built.
- `CURRENT_PROJECT_VERSION` is the build number. It starts at 1. Apple requires it to rise for each upload of the same version. It can restart at 1 for a new version.
- A Release build shows `CFBundleShortVersionString` 0.12.5 and `CFBundleVersion` 1 for the app and for the extension.
- The version must also rise from upload to upload. Nothing was uploaded before, so 0.12.5 is a valid start.

Rejected: stamp the version at archive time from the git tag with a script.
This keeps the rule of one version number.
It loses the Archive button of Xcode for the local upload.

#### 136-5b: the first upload from the Mac

Needs the paid account.
The first upload of version 0.12.5 succeeded on 16 November 2026, after the fix in "First upload failure".
TestFlight processing of the build and the internal test are not done.

The steps of the owner:

1. Select the team in Xcode.
2. Make the App ID.
3. Download the APNs key. Apple allows the download once, so keep the file safe.
4. Run `chalkctl push apns set` with the key.
5. Make the app record in App Store Connect. The name must be unique on the App Store.
6. Set `MARKETING_VERSION` of the app and of the extension to the current chalk version. If the version is unchanged since the last upload, raise `CURRENT_PROJECT_VERSION`.
7. In Xcode, choose Archive, then Distribute, then App Store Connect.
8. Test with TestFlight internal testers first.

#### 136-5c: the GitHub release job

- A new `ios` job in `.github/workflows/release.yml` runs on a macOS runner for each `v*` tag.
  1. It sets the version. How it does this is open, because of the decision in "Version of the app". The job possibly reads the version from the project file or sets `MARKETING_VERSION` from the tag.
  2. It sets `CURRENT_PROJECT_VERSION` from the run number, because Apple rejects an upload whose build number does not increase.
  3. It runs `xcodebuild archive`.
  4. It runs `xcodebuild -exportArchive` with the upload to App Store Connect.
- The job uses no fastlane and no other dependency.
- Signing uses an App Store Connect API key (the `.p8` file, the key id, and the issuer id) with `-allowProvisioningUpdates`.
  Apple then manages the certificate and the profile, and GitHub stores no certificate.
- The three values go in a protected GitHub environment named `release`, not in repository secrets.
  The key must be revocable.
- The actions in the job are pinned to commit hashes.
- The key goes into the threat model next to the desktop signing secrets.
  To check: the role that this key needs. Admin is believed necessary for managed signing.

#### Manual steps

- Once: the app record, the API key, the external tester group, and its public link.
- Once: Beta App Review for the first build of the external group.
  Guideline 4.2 (minimum functionality) is the risk for an app that is a web view.
- For each later build: one click to add the build to the group.
  The App Store Connect API can automate this later.

#### Checks before relying on it

- If the `ios` job of `ci.yml` runs on GitHub with Xcode 27.
  The project uses the project format of Xcode 27.
  The fallbacks are a self-hosted runner on the Mac of the owner, or Xcode Cloud.
- The cost of macOS runner minutes. They cost more on a private repository.

#### TestFlight facts

Read in the Apple documentation on 16 November 2026.
The pages are old, so check each fact in App Store Connect.

- An app has up to 10,000 external testers.
- A build stays available for 90 days.
- Only the first build of an external group needs review. Later builds "may not require a full review".

## Threat model draft

Slice 136-1 is the first built slice.
The shell text is now in [threat-model.md](../threat-model.md), section "The iOS shell (phase 136)".
The list below is the design draft. The item about APNs is decided, and the third-party section for it is now in the threat model. The item about passkeys waits for a measurement.

- The shell is a new binary that the user must trust.
  The developer signs it and Apple delivers it.
  It can read all that the page shows.
  The desktop app has the same property ([threat-model.md](../threat-model.md), "The desktop app's update channel", lines 368-395).
- The home server still serves the client.
  The statement in `docs/threat-model.md:209-215` does not change.
  The statement says that a MITM that serves the SPA bundle itself is endpoint compromise.
- The native APNs sender is a second third party after web push (`docs/threat-model.md:396-470`).
  Apple sees only ciphertext and the device token (see 136-4).
  The sender holds the `.p8` key of the developer team, a new secret on the server.
  The key went into the threat model with 136-4b, when chalkd could send.
  The App Store Connect API key of 136-5 is a second new secret, in GitHub.
- Passkeys possibly do not work in the web view.
  Associated domains are compiled into the app, and each server has its own domain.
  Password with TOTP is not affected.
  136-1 tests this.

## Preconditions and unknowns

- A Mac with Xcode: present.
- A paid Apple Developer account: absent. The owner will buy one. It is necessary for 136-4d and 136-5.
- Background capture in the shell: works for app switch and screen lock on iOS 27.2.1. Measured in 136-1, including a 5-min run of each.
- Background capture in the Home Screen web app: unmeasured.
- `Notification` and `PushManager` in the shell: absent (see "Page facts").
- Passkey sign-in in the shell: untried (see "Open measurement").
- The iOS versions that matter: only iOS 27.2.1 was tested.

## Sources

The Apple pages for 136-4 and 136-5 were read on 16 November 2026.

- [TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/): the limit of external testers and the 90 days of a build.
- [Invite external testers](https://developer.apple.com/help/app-store-connect/test-a-beta-version/invite-external-testers/): the review of the first build of an external group.
- [Communicating with APNs](https://developer.apple.com/library/archive/documentation/NetworkingInternet/Conceptual/RemoteNotificationsPG/CommunicatingwithAPNs.html): the rules for the provider token and the request headers.

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

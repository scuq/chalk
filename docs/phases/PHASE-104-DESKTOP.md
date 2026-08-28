# Phase 104 — a desktop app

**Status:** all four slices built — 104-1 the shell, 104-2 tray and
close-to-tray, 104-3 system idle → presence, 104-4 packaging, release
workflow and the update notice; 104-5 (2026-08-26) fixed the idle clock
latching *locked* across a Mac sleep; 104-6 (2026-08-29) fixed the pop-out
call window freezing the shell. The first release that carries desktop
archives closes the phase; one-click self-update is phase 105 (planned).
Research done 2026-08-24.

**Tag:** `#desktop` → `tools/where.sh -g desktop` (the 104-* comments live in
`desktop/src/`; 104-3 will add `web/src/presence/desktop-idle.ts`).

## The problem

chalk runs in a browser tab or as an installed PWA. scuq wants it as an app
of its own on Windows, macOS and Linux — no browser to open — and three
things a tab or a PWA cannot do:

1. **Away detection that sees the whole desktop**, not the chalk window.
   Today only Chromium's `IdleDetector` does that; phase 90 designed a local
   agent so Firefox and Safari could have it too.
2. **Close to tray.** Closing the window keeps chalk running: presence stays
   honest, notifications keep arriving, the page keeps its keys warm.
3. **Links open in the system's default browser.** A PWA installed from
   Chrome opens links in Chrome even when Firefox is the default.

## What the client demands of a shell

The client is hard-wired to **same-origin**, and a shell must respect that:

- every fetch is a relative `/api/…`; the socket is
  `` `${location.host}/ws` `` (`App.tsx`, `GuestRoom.tsx`);
- `internal/server/spa.go` serves `connect-src 'self'` — the page may talk
  to nothing but the origin it came from;
- the WebAuthn RP origin (`CHALK_RP_ORIGINS`), the server-identity pin
  (`crypto/server-pin.ts`), join links and the `Secure; SameSite=Strict`
  session cookie are all keyed on the server origin.

So the shell loads `https://<server>/` and nothing else. Embedding
`web/dist` behind an app scheme would break the CSP, the cookie, the
passkey ceremony and the pin store in one move. **Nothing of chalk is
bundled into the desktop app**; the server's page is the app, unchanged.

The page also needs, from whatever engine hosts it:

- native WebCrypto Ed25519 + X25519 (`crypto/support.ts` refuses to boot
  without them — Chromium ≥137, WebKit ≥17);
- WebRTC: `getUserMedia`, `RTCPeerConnection`, `getDisplayMedia`,
  `setSinkId` (`web/src/voice/`);
- `Notification`, IndexedDB structured-clone of non-extractable
  `CryptoKey`s (`crypto/idb.ts`), blob `<a download>`, `window.open` for
  the recovery-phrase print window and the pop-out call.

## Research: which engine

| Option | Engine | Verdict for chalk |
| --- | --- | --- |
| Wails v2 (what `~/f9` uses), Wails v3 beta, Tauri v2, Electrobun (default), webview_go, Neutralino | the OS webview: WebView2 / WKWebView / WebKitGTK | **Windows** complete (WebView2 is Chromium). **macOS** WKWebView: calls and (14+) screen share, but no `Notification`, no WebAuthn, no `setSinkId`, blob downloads ignored. **Linux**: no calls at all — see below. |
| Servo/Verso runtime for Tauri | Servo | WebRTC streams are dropped, no WebAuthn. Not viable. |
| Electron, Electrobun `bundleCEF`, NW.js, `energye/energy` | bundled Chromium | Every feature everywhere. ~100 MB per download. |
| A Go launcher driving an installed or bundled Chromium in `--app` mode | Chromium | Every *web* feature, pure Go, cross-compiles — but a separate process: cannot veto the window's close, hide it on all three OSes, or intercept `target=_blank`. Fails requirements 2 and 3. |
| The PWA, documented | the user's browser | Zero code, but fails requirement 3 by definition and 1–2 on Firefox/Safari. |

**Linux is what decides it.** Debian 13's `libwebkit2gtk-4.1-0 2.52.5` is
built without WebRTC: the library has no `RTCPeerConnection` bindings,
upstream's `OptionsGTK.cmake` ties `ENABLE_WEB_RTC` to
`ENABLE_EXPERIMENTAL_FEATURES`, and Debian's `rules` never sets it. The
WebKitGTK maintainers' FOSDEM 2026 status talk says WebRTC stays off in
release builds; the Tauri users who got it working compiled WebKit
themselves. Every OS-webview shell is therefore text-only on Linux, and
chalk without calls on Linux is not chalk.

**Electron** is the pick because requirements 1–3 are first-class APIs
(`powerMonitor`, `Tray` + `hide()`, `setWindowOpenHandler` +
`shell.openExternal`), it is the best-documented of the bundled-Chromium
shells, and its Chromium (≥144 in v42) clears the crypto floor. Electrobun
with `bundleCEF` was the runner-up: it has `Tray` and `openExternal` but no
idle/power API, and its screen-share and passkey behaviour under CEF is
undocumented.

What Electron costs, recorded so nobody rediscovers it:

- **No built-in screen-share picker.** `useSystemPicker` gives macOS 15+'s
  native one; Windows and Linux need a chooser of our own, fed by
  `desktopCapturer` — `desktop/src/screenshare.ts` + the picker page.
- **System audio in a share** is Windows-only (`audio: "loopback"`). The
  page's existing no-system-audio path covers the rest.
- **macOS passkeys** need a native module (`electron-webauthn-mac`);
  deferred. Password + TOTP always works; Windows Hello works through
  Chromium's Windows WebAuthn.
- **Linux lock detection** is not in `powerMonitor`; idle time is. Same gap
  phase 90 records for wlroots.
- **~100 MB per platform download**, and an npm tree in `desktop/` that must
  stay `npm audit`-clean like `web/` and `test/e2e/`.

A bonus worth naming: a window hidden to the tray keeps the page alive, so
notifications and presence keep working "while closed" — the case
`docs/notification-sounds.md` says only push could have covered.

## The design

`desktop/` is its own npm package (TypeScript, esbuild, `node:test` — the
same drivers as `web/`), no Go, no cgo. The main process is small on
purpose; the page is the product.

```
desktop/src/
  main.ts          bootstrap, single instance, menu, navigation policy, picker IPC
  config.ts        desktop.json under app.getPath("userData"): servers, last, bounds   (tested)
  links.ts         in-app | child | external | deny                                (tested)
  permissions.ts   the short allow-list, scoped to the server origin               (tested)
  screenshare.ts   setDisplayMediaRequestHandler → chooser (or macOS system picker)
  window.ts        the main window, the modal chooser, child-window options
  preload.ts       chalkPicker for file: pages, chalkDesktop for the server's page
  picker/          picker.html/.css/.ts: server picker and share chooser, one page, two modes
```

- **Navigation.** `will-navigate` and `setWindowOpenHandler` both go through
  `classifyLink`: same origin stays; `about:blank` pop-ups (the client's
  print window and pop-out call) get a real child window; any other
  http(s)/mailto goes to `shell.openExternal`; the rest is dropped. A
  same-origin `target=_blank` loads in the window we have.
- **Permissions.** A fixed list (`media`, `display-capture`,
  `notifications`, clipboard, fullscreen, idle-detection) granted only to the
  server origin; everything and everyone else is denied. No prompts.
- **Picker.** With no `--server` and no remembered `last`, the window shows
  the shell's own `file:` page: remembered servers, a field for a new one.
  `normalizeServerURL` reduces input to an origin and refuses plain http
  except on loopback (`--insecure` widens it for a LAN test box). A server
  that fails to load bounces back to the picker with the reason.
- **Preload split by protocol.** A remote page never sees the picker's IPC;
  the main process double-checks the sender frame is `file:` before serving
  any `picker:*` call.
- **Hardening.** `contextIsolation`, `sandbox`, no node integration, in every
  window including the child pop-ups; the picker page carries its own CSP.

Rejected along the way:

- **Embedding `web/dist`** — see "What the client demands".
- **A Wails shell first, Electron later** — the Linux finding made the
  probe pointless.
- **`electron-builder`** — `@electron/packager` produces the zips 104-4
  needs with far fewer transitive packages; installers can come later.

## Slices

- **104-1 — the shell.** Built. Window, server picker, single instance,
  link routing, permission policy, screen-share chooser, `npm start`
  against the dev stack.
- **104-2 — tray + close-to-tray.** Built. `desktop/src/tray.ts`: a `Tray`
  (the app icon resized at runtime, 18/16/22 px) with Open / Switch server… /
  Quit; the window's `close` hides it unless `before-quit` has run (menu,
  Cmd/Ctrl+Q, tray Quit) or `desktop.json` says `"closeToTray": false`; tray
  click, dock click (`activate`) and a second launch all `showWindow`. The
  hidden page stays connected, so notifications and presence keep working
  with "chalk closed". Windows gets `app.setAppUserModelId("org.chalk.desktop")`
  — toasts read "chalk" only once 104-4's installer creates a shortcut with
  that id. GNOME needs an AppIndicator extension to show any tray at all;
  without it the window still hides and comes back via the launcher (see the
  header of `tray.ts`).
- **104-3 — system idle → presence.** Built. `desktop/src/idle.ts` reads
  `powerMonitor.getSystemIdleTime()` (and `getSystemIdleState` for the lock)
  every 15 s and on `lock-screen`/`unlock-screen`/`resume`, and pushes raw
  `{idleMs, locked}` to the window; the preload exposes
  `chalkDesktop.idle.get()/subscribe()` and the page can pull its opening
  value over `chalk:idle:get` (answered only to the main window's own
  webContents). Web side: `web/src/presence/desktop-idle.ts` applies
  `system-idle.ts`'s `THRESHOLD_MS` (now exported) and feeds
  `idleWatch.setSystem` with the same `{idle, locked}` contract; `App.tsx`
  makes the shell the one system source (`mayWatchSystemIdle` gains
  `!desktopIdle`) under the existing `systemIdle` pref; `ProfilePanel` shows
  the away toggle in the shell with its own copy. Linux reports no lock
  through `powerMonitor` — idle time only, the same gap phase 90 records for
  wlroots. Nothing crosses the network that did not before: the page sends
  the same `presence_update`.
- **104-5 — locked is derived, and the clock logs.** Built. Bug from a Mac
  that slept and woke: the shell stayed *away* until restarted. `idle.ts`
  latched `locked = true` on one `getSystemIdleState() == "locked"` and
  cleared it only on `unlock-screen`. Two ways that sticks on macOS.
  Chromium's "locked" (`ui/base/idle/idle_mac.mm`) is itself a pair of
  notification latches — `screensaverRunning || screenLocked`, set by
  `com.apple.screensaver.didstart` / `screenIsLocked`, cleared by `didstop`
  / `screenIsUnlocked`, never re-queried, no wake handling — and a Mac that
  sleeps through the screensaver does not reliably post `didstop` on wake,
  so every 15 s tick re-latched what the unlock had just cleared. And a
  screensaver with no password produces no `unlock-screen` at all, so the
  latch had nothing to clear it. A third hazard: `onUnlock` published via
  `read()`, and Electron's observer and Chromium's observer of the same
  `screenIsUnlocked` notification run in unspecified order, so the unlock
  handler could re-latch inside itself. Fix: `desktop/src/idle-clock.ts`
  (pure, tested) derives `locked` on every read as `eventLocked ||
  (osState == "locked" && idleMs >= STALE_LOCK_MS)` — the shell's own
  lock/unlock edge stays immediate, and an OS lock only counts on its own
  after 30 s without input, since input is what ends a screensaver. The
  publisher logs every power event (`lock-screen`, `unlock-screen`,
  `suspend`, `resume`) and every tick on which the OS answer or the verdict
  changed, as `chalk-desktop idle: <why>: os=… idle=…s events=… ->
  locked=…` on stdout. The reconnect path was checked and is not involved:
  chalkd sets *online* on connect and the page re-sends `presence_update`
  when the socket reopens. Not yet confirmed on a real Mac — the checklist
  below says what to watch.
- **104-6 — pop-outs: no Document PiP, pop-ups sized as asked.** Built.
  "popout" on a call tile froze the shell. `voice/pip.ts` tries Document
  Picture-in-Picture first wherever `documentPictureInPicture` exists and
  only falls back to `window.open` when `requestWindow()` rejects; Electron
  exposes the API but does not implement it (electron/electron#39633, open
  since 2023) — measured with the Playwright-Electron probe against the dev
  server: our `setWindowOpenHandler` sees an empty-URL `child` request and
  allows it, Electron creates a BrowserWindow with no document, the promise
  never settles and the renderer stops answering input and `evaluate`. Fix
  in the shell, not the page: `app.commandLine.appendSwitch
  ("disable-blink-features", "DocumentPictureInPictureAPI")` before
  `whenReady`, so the page sees no API and takes its plain path, which the
  same probe showed working (child window, content in ~550 ms). That fixes
  every chalkd version the shell is pointed at; shells before this one keep
  the bug until they update. The probe also showed every pop-up coming out
  520×643 — `childWindowOptions` was sized for the recovery print and
  ignored the `features` string — so `links.ts` gains `parseWindowFeatures`
  (pure, tested: width/height/left/top, bounded 100–8192) and the handler
  passes the geometry through, with `useContentSize` so the numbers mean
  the viewport as they do in a browser; the portrait default stays for a
  pop-up that names no size.
- **104-4 — packaging, release, update notice.** Built.
  - `desktop/package.mjs` drives `@electron/packager` (20.3, pure-JS
    `resedit` for the Windows metadata — no wine) into
    `out/chalk-<platform>-<arch>/`, asar-packed, pruned to `dist/`,
    `assets/`, `package.json`. `desktop/icons/gen.mjs` renders the SVG mark
    with the run-chalk Playwright and hand-packs PNG-in-ICO and PNG-in-ICNS
    (committed outputs, regenerate when the mark changes).
  - A `desktop` job in `.github/workflows/release.yml` (one runner per OS,
    both arches per runner, Node 24, `npm version` stamps the tag), Windows
    Authenticode with the self-signed cert from `tools/make-signing-cert.sh`
    (secrets `WIN_SIGN_PFX_B64` / `WIN_SIGN_PFX_PASSWORD`, skipped when
    absent), macOS unsigned like f9. The release job downloads whatever
    desktop artifacts exist, writes and cosign-signs `SHA256SUMS.desktop`,
    and **does not fail when the desktop job did** — the server release is
    never held hostage by a runner problem.
  - `desktop/src/update.ts`: once 20 s after launch and then daily, the
    shell reads `releases/latest`, and when it is newer shows a one-time
    dialog (per version, `notifiedVersion` in `desktop.json`) and keeps an
    "Update to vX…" entry in the tray and the chalk menu; both open the
    release page in the system browser. No download, no execution — that is
    phase 105, behind signed sums. Dev builds and `"checkUpdates": false`
    never ask. `chalk --version` prints shell, Electron and Chromium versions;
    `chalk --install-desktop-entry` (Linux) writes the `.desktop` file and
    icon under `XDG_DATA_HOME`.

Deferred to their own phases: one-click self-update (105), the macOS
passkey module, unread count on the tray icon, Linux lock via logind,
msi/dmg/deb installers.

## Manual checklist (104-1)

Against the run-chalk dev stack, `cd desktop && npm start -- --server
http://localhost:8443` (localhost, not 127.0.0.1: the dev RP origin).

A Playwright-Electron probe (`.claude/skills/run-chalk/probes/ui.mjs`, the
scratch slot — rewrite it from this description if it is gone) covered the
items marked ✔ on Linux, 2026-08-24, 18/18: picker on first launch, bad
address refused, server loads, preload split by protocol, Ed25519/X25519
present, `Notification.permission === "granted"`, camera permission granted,
foreign `window.open` and `target=_blank` reach `shell.openExternal` with no
second window, `about:blank` pop-up becomes a child window, full
registration to the chat UI, relaunch skips the picker and keeps the
identity.

- [x] picker shows with no config; a bad address is refused with a reason ✔
- [x] signup (password + TOTP + phrase); relaunch keeps the identity ✔
- [ ] messages send and receive; attachments upload and **save to disk**
- [ ] a 2-party call: mic + camera granted without a prompt; remote video
- [ ] screen share: the chooser lists screens and windows; the share starts;
      Cancel rejects cleanly and the page recovers
- [ ] a notification toast from a background channel
- [x] a pasted `https://` link opens the **system** browser ✔; a same-origin
      join link stays in the window (classifier tested, not driven)
- [x] recovery-phrase **print** window opens as a child window ✔ (as
      `about:blank`; the print itself not driven)
- [ ] second launch focuses the running window
- [ ] Ctrl/Cmd+Shift+S returns to the picker; the previous server is listed

104-2, same probe (Linux, 2026-08-25):

- [x] close hides the window; it is neither destroyed nor a second window ✔
- [x] the page is still mounted while hidden ✔; show brings the same window
      back ✔
- [ ] tray icon visible with Open / Switch server… / Quit (needs a hand on a
      real desktop; the probe cannot click a tray)
- [ ] a message arriving while hidden produces a toast
- [ ] Quit from the tray ends the process; `"closeToTray": false` makes the
      close button quit

104-3, same probe (Linux, 2026-08-25):

- [x] `chalkDesktop.idle.get()` answers `{idleMs, locked}` ✔
- [x] a `lock-screen` event (emitted on `powerMonitor` from the probe) flips
      the header to *away* at once; `unlock-screen` brings *online* back ✔
- [ ] a real lock on Windows/macOS does the same (Linux cannot report it)
- [ ] ten minutes untouched → away; first input → online
- [ ] the away toggle in settings turns the source off and on

104-5 (needs a Mac; not yet run):

- [ ] run the shell from a terminal, sleep the Mac (lid or menu), wake,
      unlock: the `chalk-desktop idle:` lines show `suspend`, `resume`,
      `unlock-screen`; within one tick of the first keystroke the last line
      says `locked=false` and the header is *online*
- [ ] if `os=locked` keeps appearing on later ticks while `idle=` is small,
      that is Chromium's stale screensaver latch — the fix is doing its job;
      note it here
- [ ] screensaver with "require password" off: it starts, it stops on
      input, the header goes *online* without an `unlock-screen` line

104-6, probe (Linux, 2026-08-29):

- [x] with the switch, `typeof documentPictureInPicture` is `undefined` in
      the page ✔
- [x] `window.open("", name, "popup=yes,width=400,height=300,…")` from a
      click opens a child window, the page writes into it, and the viewport
      is the 400×300 it asked for ✔ (`useContentSize`: features mean the
      content area, Electron's default meant the outer frame — 400×263)
- [ ] in a real call on macOS/Windows: "popout" on a tile opens a window
      shaped like the video, a second one cascades, leaving the call closes
      them

104-4 (Linux, 2026-08-25):

- [x] `node package.mjs` produces `out/chalk-linux-arm64/` (313 MB unpacked);
      the asar holds only `dist/`, `assets/`, `package.json` ✔
- [x] the packaged binary answers `--version` and `--install-desktop-entry`
      (entry + icon under a scratch `XDG_DATA_HOME`) ✔
- [x] the full probe passes against the packaged binary
      (`CHALK_PROBE_EXE=desktop/out/chalk-linux-arm64/chalk`) ✔
- [x] the release workflow's `desktop` job on a real tag — v0.8.3: Linux and
      macOS archives published, `SHA256SUMS.desktop` cosign- and
      Ed25519-signed (verified locally against the pinned key) ✔; the
      Windows job failed in `npm test` (Git for Windows' GNU tar on the
      runner reads `C:\…` as host:path) — fixed for v0.8.4, which then
      tripped a Unix-only execute-bit assertion in a test; v0.8.5 is the
      first tag whose Windows job can reach packaging
- [ ] the Windows archives and their Authenticode signature (needs the
      `WIN_SIGN_*` secrets, still unset)
- [ ] the update dialog and menu entry against a real newer release (a dev
      build never checks; stamp a lower version to see it)

Per-OS builds repeat the 104-1…3 lists on real Windows, macOS and Linux.

## Keeping the engine current

The shell's browser engine is whatever Chromium the pinned Electron embeds,
and that is the only place it can be set. Electron's stable line trails
Chrome stable by one major on purpose: on 2026-08-24, Chrome stable was 152,
Electron `latest` 43.4.1 embedded Chromium 150.0.7871.224 (Node 24.18.1),
and the 44 beta already carried 152.0.7977.30 (read
`chromium_version` in Electron's `DEPS` at a tag to check). A beta is not
what to ship. The rule for `desktop/package.json`:

- pin `electron` to the registry's `latest` dist-tag (`npm view electron
  dist-tags`), exact version, and take every patch release — those carry the
  Chromium security backports;
- move to the next major the week it goes stable (Electron ships one every
  eight weeks); 104-4's monthly bump job is where that becomes routine;
- same for esbuild and typescript: exact pins at the current stable.

`npm outdated` under npm 10 can report a *lower* "latest" for electron than
the dist-tag says; trust `npm view electron dist-tags`.

`web/` was brought to the same standard in the same change set (esbuild
0.28, TypeScript 7, preact 10.29, qrcode-generator 2.0, tasks-vision 1.0.1).
The one migration TypeScript ≥5.7 forced is `web/src/crypto/bytes.ts`:
typed arrays became generic over their buffer and the DOM lib now wants
`ArrayBuffer`-backed views for `BufferSource`/`BlobPart`, so the WebCrypto,
Blob and `ws.send` call sites wrap their bytes in `asBytes()` and the
module-local byte producers (`concat`, `utf8`, `hexToBytes`, the base64
decoders, `wrapAAD`/`msgAAD`, `nonceFor`) declare `Bytes`. Types only;
esbuild strips them and the 1373 tests are unchanged.

## Gotchas met on the way

- **Electron 43 needs Node ≥ 22.12 for `npm install`.** On a Node 20 box
  npm only warns (`EBADENGINE`) and Electron's postinstall never downloads
  the binary; `node node_modules/electron/install.js` fetches it by hand.
  The verify chain (tsc, tests, build) is fine on Node 20.
- **`ELECTRON_RUN_AS_NODE=1` is set in VS Code terminals.** With it,
  `electron` runs as plain Node (`--version` prints the embedded Node's
  version, the app never opens). Unset it before launching; the probe does.
- **Electron's `chrome-sandbox` is not setuid in `node_modules`.** With
  unprivileged user namespaces on (Debian 13 default) the namespace sandbox
  is used and it does not matter; the probe passes `--no-sandbox` only so it
  cannot depend on that.
- TypeScript is pinned at 7.x (the native compiler); the `web/` config
  carried over unchanged.

## Verification

```bash
go build ./... && go vet ./... && gofmt -l . && go test ./...
cd web && npx tsc --noEmit && node test.mjs && node build.mjs
cd desktop && npx tsc --noEmit && node test.mjs && node build.mjs && npm audit
```

`desktop/src/*.test.ts` pin the pure parts: origin normalisation and the
config's tolerance of garbage, the four link bins, the permission
allow-list and its origin scoping.

## Sources

- WebKitGTK WebRTC status, FOSDEM 2026:
  <https://fosdem.org/2026/events/attachments/KMMLGM-webrtc_support_in_webkitgtk_and_wpewebkit_with_gstreamer_current_status_and_plan/slides/266710/webrtc_su_twrfhlu.pdf>
- Tauri users compiling WebKitGTK for WebRTC:
  <https://github.com/tauri-apps/tauri/discussions/8426>
- `OptionsGTK.cmake` (webkitgtk-2.52.5), `ENABLE_WEB_RTC` default:
  <https://raw.githubusercontent.com/WebKit/WebKit/webkitgtk-2.52.5/Source/cmake/OptionsGTK.cmake>
- Debian's build flags: <https://sources.debian.org/data/main/w/webkit2gtk/2.52.5-1~deb13u1/debian/rules>
- WKWebView `getDisplayMedia` on macOS 14 (wry #1195): <https://github.com/tauri-apps/wry/issues/1195>
- wry 0.56 permission API: <https://tauri.app/release/wry/v0.56.0/>
- Wails v3 beta: <https://v3.wails.io/blog/wails-v3-beta/>
- Electrobun, `bundleCEF`: <https://github.com/blackboardsh/electrobun>
- Electron passkeys on macOS: <https://vault12.com/press-posts/130126-electron-webauthn/>
- Electron releases: <https://releases.electronjs.org/>

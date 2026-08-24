# Phase 104 — a desktop app

**Status:** 104-1 (the shell), 104-2 (tray, close-to-tray) and 104-3 (system
idle → presence) built. 104-4 packaging is designed below and not started.
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
- **104-4 — packaging.** `@electron/packager` zips for win/mac/linux ×
  x64/arm64; `.github/workflows/desktop-release.yml` after
  `~/f9/.github/workflows/release.yml` (per-platform runners, Windows
  self-signed Authenticode, unsigned macOS like f9); README "Desktop app";
  `docs/browser-support.md` desktop row; CHANGELOG entry.

Deferred to their own phases: auto-update, the macOS passkey module, unread
count on the tray icon, Linux lock via logind, msi/dmg/deb installers.

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

Per-OS builds (104-4) repeat the list on real Windows, macOS and Linux.

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

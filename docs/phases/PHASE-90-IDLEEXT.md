# Phase 90 — system idle on the browsers that refused the API

A companion WebExtension that tells chalk whether anyone is actually at the
machine, on Firefox as well as Chromium, and turns the away delay into a setting
instead of a constant. Designed against v0.7.4 plus the unreleased 45-6 / 45-7
threshold work. **NOT IMPLEMENTED — no code exists.** This document is the plan
and nothing below it has been built.

**Status:** design only, written 6 August 2026.
**Tag:** `#presence` → `tools/where.sh -g presence` (phases 34, 45, 60, and this
one once it lands).

## The problem

Away detection stacks three layers, and `web/src/presence/idle.ts:7-17` names
them in the order of how much they know:

| layer | where | what it can see |
| --- | --- | --- |
| in-page input + focus | everywhere | "not interacting with chalk" |
| `IdleDetector` | Chromium only | no input to **any** app, plus the screen lock |
| server TTL demotion | already shipped | "the machine is gone" |

The middle one is the only layer that can see input chalk never received, and it
is what separates reading a long thread from having walked away. `decideIdle`
leans on it hard: rule 4 (`web/src/presence/idle.ts:109`) is
`systemIdle === false → not idle`, which **suppresses all three in-page windows**
for someone who is at their machine but not touching chalk. That rule is
load-bearing, and 45-6's note about it still applies here.

Firefox and Safari do not have that layer and never will — both Mozilla and
WebKit filed negative standards positions, which `system-idle.ts:9-11` already
records. What those users get instead is the in-page windows alone: after 45-7,
~5m50 for a hidden tab, 23 minutes unfocused, 35 minutes focused. So on Firefox:

- chalk sitting in front of a **locked screen** reports online until the focused
  timeout expires, half an hour later. The lock is the one signal that deserves
  no grace at all (rule 1), and Firefox never sees it.
- chalk on screen beside the app you are working in reports online for 23
  minutes after you leave for lunch, because "unfocused" is weak evidence and
  47-7 / 60-1 relaxed it for good reasons that have nothing to do with absence.

And on Chromium, where the layer does exist, the away delay is one compile-time
number (`THRESHOLD_MS = 600_000`, `system-idle.ts:49`) behind a permission
prompt, chosen once for everybody.

Both of these are cosmetic-dot problems, and the dot is not the only consumer:
`userIdle` also gates notification sound and banners
(`web/src/notify/gate.ts:81`, `:139`) — "on screen is not the same as being
read". A wrong idle verdict on Firefox is a chalk that stays quiet for a channel
nobody is in front of, or chimes for one you are.

## What it is

A small WebExtension holding the `idle` permission, which reports the OS's view
of the session — `active`, `idle`, or `locked` — into the chalk page. The `idle`
API is supported by **both Firefox and Chromium** and yields exactly the two
facts `IdleDetector` yields.

The extension is deliberately dumb. It holds no policy and no chat data, knows
nothing about accounts, channels or keys, and can be read end to end in a couple
of minutes. It answers one question and the page decides what it means.

```
chrome.idle.onStateChanged  (background service worker)
  → port → content script (isolated world)
    → window.postMessage → page
      → ext-idle.ts → idleWatch.setSystem({idle, locked})   ← the existing seam
        → decideIdle → presence_update
```

`setSystem({idle, locked})` (`idle.ts:227`) does not change. `ext-idle.ts` is a
second source with the same contract `startSystemIdle` already has
(`system-idle.ts:103`), and the page picks exactly **one**: the extension if it
is there, otherwise `IdleDetector`, otherwise nothing. Running both would push
two opinions of one fact into a single watcher, and the teardown path already
has the right instinct — back to *unknown*, never to `false`.

## Why not a helper binary

The question that opened this phase was whether a native helper on the OS could
do better. It can, in principle: real idle-seconds rather than a threshold
crossing, a lock signal on every desktop, and coverage of Safari too. It costs
more than it is worth here.

A helper the page can reach means the page opening a connection to
`127.0.0.1`, and `connect-src 'self'` (`internal/server/spa.go:109`) forbids
that. That directive is the one `spa.go:70-78` calls "the directive carrying the
weight", on the grounds that chalk is a blind relay and pinning every outbound
connection to our own origin is what stops a compromised bundled dependency from
talking to anyone but us. `PHASE-88-FEDERATION.md:290` refused to relax it for
federation and `PHASE-57-LINKPREVIEW.md:18` refused for link previews. Spending
it on a presence dot would be the weakest reason yet.

The alternatives to relaxing it are worse:

- **Helper reports to chalkd instead of the page.** No CSP change, and it would
  even work with the browser closed — but it puts a long-lived credential on the
  user's desktop, adds an endpoint and a token store to a server whose auth model
  phases 31 and 81 worked hard on, and stops presence being a property of live
  connections, which is the whole point of phase 34. And "chalk is not open" is
  a defensible reading of offline; the TTL demotion already covers it.
- **A desktop shell.** `PHASE-88-FEDERATION.md:186-192` names this as the
  existing answer to this class of problem, and it is — but shipping an Electron
  or Tauri app to solve away detection is not a trade anyone would make.

A content script, by contrast, is not bound by the page's CSP, so the extension
needs no relaxation at all — and no per-OS backend, no D-Bus probing across the
Wayland/X11 split, no background daemon to install, and no third binary in the
release train.

## What it does not fix

**Safari.** Its extensions must be wrapped in a signed macOS app built in Xcode,
and `browser.idle` is not among the WebExtension APIs it supports. Safari keeps
the in-page fallback, and the settings copy should say so rather than offer a
link that leads nowhere. This is the one place the helper binary would have won.

## Design decisions

### The origin is opted into, not baked in

chalk is self-hosted, so the extension cannot know the deployment's origin at
build time. It ships with **no host permissions**: `optional_host_permissions`
plus a toolbar popup where the user enables the site they are looking at, which
calls `permissions.request()` and then
`scripting.registerContentScripts({ persistAcrossSessions: true })`, followed by
an immediate `scripting.executeScript` so the already-open tab starts working
without a reload.

`<all_urls>` at install time would have been one line shorter and is out of the
question — an extension that reads every page you visit, shipped by a project
whose entire argument is that the server cannot read your messages, would be a
self-inflicted wound.

### The threshold lives in the page

The page sends its away delay down and the extension applies it with
`idle.setDetectionInterval(ms / 1000)`. One number, one owner. The API's floor is
15 seconds, comfortably under `IdleDetector`'s 60, so the extension can express
any policy the page wants.

45-6's rule survives intact and is worth restating because it is exactly the
mistake this phase could make twice: **damp this signal by raising the
threshold, never by adding a second timeout inside `decideIdle`.** A `systemIdle`
verdict outranks all three in-page windows by construction; a second timeout
layered on top would silently re-break everything 47-7, 60-1 and 45-7 relaxed.

### The message envelope

Page and content script share a window, so `window.postMessage` is the channel.
Every message is namespaced under `__chalkIdle: 1`, and the page checks both
`event.source === window` and `event.origin === location.origin`.

| kind | direction | fields |
| --- | --- | --- |
| `hello` | ext → page | `version` |
| `hello?` | page → ext | — |
| `threshold` | page → ext | `ms` |
| `state` | ext → page | `idle`, `locked` |
| `bye` | ext → page | — |

`hello` and `hello?` are both present because either side can load first: the
content script announces itself on injection, and the page asks on mount. A late
`hello` — the user enabling the origin from the popup while chalk is open —
switches the page's source over without a reload, which is the same path a
reconnect takes.

Spoofing this from same-origin script is possible and uninteresting. Anything
that can `postMessage` into the page already owns the page, and the prize is a
wrong presence dot.

### No server code

No frame type, no migration, no handler, no env var. The one thing that might
have touched Go — serving the signed XPI from chalkd — is better done as a link
to the release asset, which keeps a binary blob out of the image and leaves
`internal/` untouched by this phase entirely.

## Slices

- **90-1** — the extension. New `ext/` at the repo root, sibling of `tools/`:
  `manifest.json` (MV3, `permissions: ["idle", "scripting", "storage"]`,
  `optional_host_permissions`, `browser_specific_settings.gecko.id` for Firefox),
  `background.js`, `content.js`, `popup.html`, `popup.js`, `README.md`. Plain
  JavaScript, **no build step and no bundler** — it is about 150 lines and a
  toolchain for that would be exactly the kind of thing the dependency rules rule
  out. The content script reconnects its port on `onDisconnect`, because an MV3
  service worker is allowed to go away underneath it.
- **90-2** — the page-side source. `web/src/presence/ext-idle.ts` mirroring
  `system-idle.ts`'s shape, plus `ext-idle.test.ts` following the fake-globals
  pattern in `system-idle.test.ts:30-36`. Wire into `App.tsx:3174-3225`: an
  `extIdlePresent` flag, and `mayWatchSystemIdle` gains `&& !extIdlePresent`.
- **90-3** — the settings section. `ProfilePanel.tsx:1281` gates the whole away
  block on `systemIdleSupported()`, which is why Firefox sees nothing today;
  gate it on either source, name which one is in use, and offer the install link
  where neither is. The "chrome and edge only" copy at `:1297` stops being true.
  Add the keywords to the `away` entry in `web/src/settings-nav.ts`.
- **90-4** — away delay as a setting. `awayAfterMs` in `IdlePrefs`
  (`web/src/presence/idle-prefs.ts`), default 600_000 to match today, fed to both
  sources — `setDetectionInterval` for the extension, `start({ threshold })` for
  `IdleDetector`, clamped to that API's 60s floor. This slice stands on its own:
  it improves Chromium whether or not anyone installs the extension.
- **90-5** — packaging. Extend the `binaries` job in
  `.github/workflows/release.yml:98-160` rather than adding a job: that
  workflow's header records the deliberate move to one `v*` tag and one version
  for everything. Zip `ext/` for Chromium; sign the Firefox XPI through AMO's
  unlisted signing API so it can be self-hosted and installed from a link.
  Attach both beside `chalkctl_linux_*`.

## Manual checklist

Left open by the slices above; none of it blocks 90-1 … 90-4.

- [ ] **AMO API credentials.** Unlisted signing needs a Mozilla account and two
      repo secrets. Until they exist the XPI can only be side-loaded in Firefox
      Developer Edition or Nightly, which is not an answer for anyone else.
- [ ] **Chromium distribution.** Chromium already has `IdleDetector`, so the
      extension is a nice-to-have there. The plan assumes a documented
      developer-mode load rather than the Web Store's fee and review.
- [ ] **Lock/unlock by hand, on both browsers.** The dot must go away with no
      grace and come back on the first input.
- [ ] **Away past the threshold with chalk focused and on screen** — the case no
      in-page rule can catch, and the reason this phase exists.

## Verification

`go build ./... && go vet ./... && gofmt -l .` should show no Go diff at all;
this phase does not touch `internal/`. Then, from `web/`:
`npx tsc --noEmit && node test.mjs && node build.mjs`.

`ext-idle.test.ts` covers the handshake in both load orders, rejection of
messages from the wrong source or origin, the threshold hand-off, and that a
missing extension resolves to *absent* rather than hanging the page's cold load.

The rest needs a browser: `about:debugging` in Firefox and `chrome://extensions`
in developer mode for Chromium, against the dev stack. A Playwright probe can
load the unpacked extension in Chromium through a headed persistent context with
`--load-extension`, which is enough to assert the settings section renders and
names the right source; Firefox's temporary-install path stays a by-hand check.

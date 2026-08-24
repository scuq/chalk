# Phase 90 — a local idle agent, and the first hole in `connect-src`

A small binary on the user's own machine that answers one question — how long
since anyone touched this computer — and a doubly-opt-in path for the chalk page
to ask it. Designed against v0.7.4 plus the unreleased 45-6 / 45-7 threshold
work. **NOT IMPLEMENTED — no code exists.** This document is the plan and nothing
below it has been built.

**Status:** design only, written 6 August 2026. Supersedes an earlier draft of
this phase that proposed a WebExtension; why it was dropped is under
[Rejected: the extension](#rejected-the-extension).

**2026-08-25, phase 104-3:** the desktop app now delivers this signal for
its own users — `desktop/src/idle.ts` reads the OS clock in the Electron
main process and `web/src/presence/desktop-idle.ts` feeds
`idleWatch.setSystem` through the preload bridge, so it needs none of the
CSP, token or pairing machinery below. It is **source #0** ahead of the
agent and `IdleDetector`: when this phase is built, 90-4's precedence
becomes shell → agent → `IdleDetector`, and `agentIdlePresent` sits beside
the `desktopIdle` flag `App.tsx` already has. `chalkidle` remains the answer
for people in a browser; nothing else in this design changes.
**Tag:** `#presence` → `tools/where.sh -g presence` (phases 34, 45, 60, and this
one once it lands).

## The problem

Away detection stacks three layers, and `web/src/presence/idle.ts:7-17` names
them in order of how much they know:

| layer | where | what it can see |
| --- | --- | --- |
| in-page input + focus | everywhere | "not interacting with chalk" |
| `IdleDetector` | Chromium only | no input to **any** app, plus the screen lock |
| server TTL demotion | already shipped | "the machine is gone" |

The middle layer is the only one that can see input chalk never received, and it
is what separates reading a long thread from having walked away. `decideIdle`
leans on it hard: rule 4 (`idle.ts:109`) is `systemIdle === false → not idle`,
which **suppresses all three in-page windows** for someone who is at their
machine but not touching chalk.

Firefox and Safari do not have that layer and never will — both Mozilla and
WebKit filed negative standards positions, which `system-idle.ts:9-11` already
records. Those users get the in-page windows alone: after 45-7, ~5m50 for a
hidden tab, 23 minutes unfocused, 35 minutes focused. So on Firefox today:

- chalk in front of a **locked screen** reports online for half an hour. The
  lock is the one signal that deserves no grace at all (rule 1 of `decideIdle`),
  and Firefox never sees it.
- chalk on screen beside the app you are working in reports online for 23
  minutes after you leave for lunch, because "unfocused" is weak evidence and
  47-7 / 60-1 relaxed it for reasons that have nothing to do with absence.

And on Chromium, where the layer exists, the away delay is one compile-time
number (`THRESHOLD_MS = 600_000`, `system-idle.ts:49`) behind a permission
prompt, chosen once for everyone.

The dot is not the only consumer. `userIdle` also gates notification sound and
banners (`web/src/notify/gate.ts:81`, `:139`) — "on screen is not the same as
being read" — so a wrong verdict on Firefox is a chalk that stays quiet for a
channel nobody is in front of, or chimes for one you are reading.

## What it is

**`chalkidle`** — a third binary in this repo, alongside `chalkd` and
`chalkctl`, and the first one that runs on a *user's* machine rather than an
operator's. It reads the OS's idle clock, listens on `127.0.0.1` and nowhere
else, and answers a single authenticated request:

```
GET /v1/idle?since=<seq>&threshold=<ms>&wait=25
Authorization: Bearer <token>
→ { "seq": 12, "idleMs": 631000, "locked": false, "source": "logind" }
```

It holds no chat data, no keys, no account, and speaks to nothing but the loopback
interface. It can be read end to end in a few minutes.

```
OS idle clock  (D-Bus / GetLastInputInfo / IOHIDSystem)
  → chalkidle, 127.0.0.1:28471, bearer token + Origin allowlist
    → fetch (long-poll) from the chalk page
      → agent-idle.ts → idleWatch.setSystem({idle, locked})   ← the existing seam
        → decideIdle → presence_update
```

`setSystem({idle, locked})` (`idle.ts:227`) does not change. `agent-idle.ts` is a
second source with the same contract `startSystemIdle` already has
(`system-idle.ts:103`), and the page picks exactly **one**: the agent if it is
paired and reachable, otherwise `IdleDetector`, otherwise nothing. Running both
would push two opinions of one fact into a single watcher, and the existing
teardown already has the right instinct — back to *unknown*, never to `false`.

Two things the agent gives that `IdleDetector` cannot:

- **Real idle milliseconds**, not a threshold crossing. The away delay becomes a
  user setting instead of a constant, and it applies on every browser.
- **A lock signal on Firefox and Safari**, where there is none today.

## The CSP question, answered

This is the part that has to be right, because `connect-src 'self'`
(`internal/server/spa.go:109`) is the directive `spa.go:70-78` calls "the
directive carrying the weight", and two phases have already refused to spend it:
`PHASE-88-FEDERATION.md:290` for federation, `PHASE-57-LINKPREVIEW.md:18` for
link previews. This phase spends a sliver of it, and the sliver has to be
measured honestly.

### 1. One fixed origin, not a wildcard

A CSP source expression can name an exact scheme, host and port. The enabled
policy adds precisely one source:

```
connect-src 'self' http://127.0.0.1:28471
```

Not `127.0.0.1:*`, not `localhost` (a name that `/etc/hosts` or a DNS answer can
point somewhere else — the literal address cannot be redirected), not `ws://`
(see [why long-poll, not WebSocket](#3-why-long-poll-and-not-a-websocket)).
28471 is a default, not a constant: above 1024 so the agent needs no privileges,
and below 32768 so no OS will have handed it to an outbound socket first — the
ephemeral ranges start at 32768 on Linux and 49152 on Windows and macOS.

**What that actually gives away.** With the policy enabled, a compromised
dependency in the bundle gains the ability to talk to one port on the machine the
browser is already running on. It cannot reach the network, cannot reach another
port, and cannot reach another host. Reaching a local process is only useful to
an attacker who already has local code execution — at which point the identity
key in IndexedDB is reachable by easier means. The invariant that a compromised
bundle "can only talk to us" becomes "can only talk to us, or to one port on your
own machine." That is a real reduction and it is why the next two sections exist.

### 2. Off unless two separate parties say yes

**Server opt-in.** A new `CHALK_IDLE_AGENT_PORT` (empty or `0` = disabled, the
default). When it is unset the served CSP is **byte-identical to today's** — the
`spa_test.go` assertion holds unchanged, and a deployment that never enables this
has given up nothing at all. The policy stops being a package-level `var` and
becomes a function of config; both shapes get pinned by tests.

Per CLAUDE.md's env-config rule, the knob is not done until chalkctl generates
it, preserves it across `--force`, and backfills it on `update` — the
`CHALK_TOTP_ENC_KEY` pattern in `init.go`. chalkctl writes it **empty**: enabling
this is an operator's deliberate act, never a default a deployment drifts into.

**User opt-in.** Even on a deployment that enabled it, the page makes no request
until the user pairs. The pairing token lives in `idle-prefs.ts` alongside the
existing per-device pref; no token means no fetch is ever attempted, no
connection is ever opened, and the away section behaves exactly as it does today.

The page learns the server's answer from `WelcomePayload`, which already carries
exactly this kind of feature-flag echo: `VoiceEnabled` (30-6) and
`WrapSigRequired` (82-6) are both there for the same reason — the client needs
the policy before its first attempt, not after a doomed round-trip. `IdleAgentPort`
joins them, and a zero means the pairing UI is not offered.

### 3. Why long-poll and not a WebSocket

Chrome gates requests from a public origin to a loopback address behind Private
Network Access, now being reworked into a Local Network Access permission: the
request is preceded by a CORS preflight carrying
`Access-Control-Request-Private-Network`, and the responder must answer
`Access-Control-Allow-Private-Network: true`. A WebSocket upgrade has no
preflight to carry that, so `ws://` is a design that works until a Chrome release
decides it does not. Plain HTTP does have one, and `chalkidle` answers it.

Expect a one-time browser prompt for local network access on Chromium. That is
consistent with the rest of this design — the whole thing is opt-in — and it is
the same shape of consent `IdleDetector` already asks for.

Long-poll rather than polling: the page passes its `threshold` and the agent
holds the request open until the derived idle boolean flips, the lock state
changes, or ~25 seconds pass. The page gets edges, not a timer, and
`decideIdle`'s existing 15-second evaluator keeps doing what it already does.

### 4. Mixed content

`http://127.0.0.1` is a *potentially trustworthy* origin, so the mixed-content
blocker permits it from an `https` page. Chrome and Firefox both implement this.
**WebKit's behaviour needs verifying before Safari is claimed as supported** — it
is on the checklist, and if Safari blocks it then Safari stays on the in-page
fallback and this phase has still fixed Firefox.

## The authentication question, answered

Four guards, each closing a different door. None of them is decorative.

1. **Bearer token.** 32 random bytes generated on first run, stored `0600` in the
   user's config dir, compared in constant time. `chalkidle pair` prints the
   one-line pairing string (port and token) that the user pastes into chalk's
   settings once.
2. **Exact-Origin allowlist.** The browser sets `Origin` and page script cannot
   forge it, so this is the guard that actually stops *another website* you
   happen to visit from asking whether you are at your desk. The allowlist starts
   empty; the first origin to authenticate successfully is pinned, and
   `chalkidle status` shows it, `chalkidle unpair` clears it. A request with a
   missing or unlisted `Origin` is refused before the token is even read, and the
   CORS response headers are echoed for that one origin only — never `*`, and
   never with credentials.
3. **`Host` header check.** The request's `Host` must be literally
   `127.0.0.1:<port>`. This is what defeats DNS rebinding, where a hostile site
   points its own name at 127.0.0.1 to inherit same-origin access; the rebound
   request still carries the attacker's hostname.
4. **Bind to `127.0.0.1` explicitly**, never `0.0.0.0`, and answer nothing on any
   other interface.

### What this does not defend against, and why that is fine

**Another process running as you, on your machine, can read the token file** —
and there is no arrangement of loopback sockets that changes that. It does not
matter: that same process can ask the OS for the idle time directly, exactly the
way `chalkidle` does. There is no secret here to protect from it, and a design
that pretended otherwise would be security theatre. What is worth defending is
the *web* boundary — random websites, and other local user accounts — and guards
1–4 close both.

The information at stake is deliberately thin. The agent answers "how long since
input, and is the screen locked". It does not know what you typed, which
application had focus, who you are, or that chalk exists beyond one pinned origin.

## Rejected: the extension

The first draft of this phase was a WebExtension using the `idle` API, which
Firefox and Chromium both support and which needs no CSP change at all, because
content scripts are not bound by the page's policy. It was dropped for reasons
that all point the same way — it does not cover enough:

- **Safari** cannot run it: its extensions must be wrapped in a signed macOS app
  built in Xcode, and `browser.idle` is not among the WebExtension APIs it
  supports.
- **Installing an unsigned extension is real work.** Firefox requires Mozilla
  signing even for a self-hosted XPI, which means an AMO account and API
  credentials in CI before anyone but a Developer-Edition user can install it.
  Chrome and Brave refuse self-hosted CRX installs for ordinary users entirely —
  developer-mode unpacked loading is the only route, and it is not a thing to ask
  a chalk user to do.
- **Per-browser coverage stays ragged**, and every browser is a separate
  packaging and signing story that has to be maintained forever.

The binary has the opposite shape: one artifact per OS, built and cosign-signed
by the release workflow that already does exactly this for `chalkctl`, and one
answer that every browser gets the same way.

## Also rejected: the agent reporting to chalkd

The agent could hold a scoped device token and post presence to the server
directly. It needs no CSP change, and it would even work with the browser closed.
It loses anyway: it puts a long-lived credential to your chat server on the
desktop, adds an endpoint and a token store to an auth model phases 31 and 81
worked hard on, and stops presence being a property of live connections, which is
the whole point of phase 34. "chalk is not open" is a defensible reading of
offline, and the TTL demotion already covers it.

It stays worth remembering as the escape hatch if WebKit turns out to block
loopback fetches, since it is the only shape that would reach Safari.

## Reading the OS clock

One dependency question and one honesty question.

- **Linux** — `github.com/godbus/dbus/v5` (mature, pure Go, no cgo), probing in
  order: `org.gnome.Mutter.IdleMonitor.GetIdletime` (GNOME, X11 and Wayland
  alike), then `org.freedesktop.ScreenSaver.GetSessionIdleTime` (KDE, xfce), then
  `org.freedesktop.login1`'s `LockedHint` / `IdleHint` plus its `Lock` and
  `Unlock` signals — which is cross-desktop and is the *lock* half of the answer
  even where no idle clock is exposed.
  **The honest gap:** wlroots compositors (sway, Hyprland) expose neither, and
  their `ext-idle-notify-v1` would need a Wayland client library this project is
  not going to take on for a presence dot. There, `chalkidle` reports lock only
  and says so. `chalkidle probe` prints which backend it found, so nobody has to
  guess.
- **Windows** — `GetLastInputInfo` through `golang.org/x/sys/windows`, already an
  indirect dependency, no cgo. It does not advance while the session is locked,
  so a locked machine reads as idle on its own.
- **macOS** — parse `HIDIdleTime` out of `ioreg -c IOHIDSystem`. Shelling out is
  not elegant, but the alternative is cgo IOKit, and cgo would break the
  `CGO_ENABLED=0` cross-compilation the release workflow depends on.

**Both dependency changes need scuq's approval before 90-2 starts:** adding
`github.com/godbus/dbus/v5` as a direct dependency, and promoting
`golang.org/x/sys` from indirect to direct.

## Slices

- **90-1** — `cmd/chalkidle` + `internal/idleagent/`: the loopback server, the
  token store and pairing commands, and all four guards above. The OS clock sits
  behind a one-method interface with a fake in the tests, so the whole security
  surface is testable in `go test ./internal/idleagent/` on any machine.
- **90-2** — the three OS backends, plus `chalkidle probe`. Build-tagged files,
  one per platform. *(Blocked on the dependency approval above.)*
- **90-3** — server opt-in: `CHALK_IDLE_AGENT_PORT` in `internal/config`, the CSP
  as a function of it in `spa.go` with both shapes pinned in `spa_test.go`,
  `IdleAgentPort` on `WelcomePayload` beside `VoiceEnabled` and
  `WrapSigRequired`, and the chalkctl template + `init.go`
  generate/preserve/backfill.
- **90-4** — the page-side source: `web/src/presence/agent-idle.ts` mirroring
  `system-idle.ts`'s shape, the pairing token in `idle-prefs.ts`, precedence over
  `IdleDetector` in `App.tsx:3174-3225` (an `agentIdlePresent` flag, and
  `mayWatchSystemIdle` gains `&& !agentIdlePresent`). Tests follow the
  fake-globals pattern in `system-idle.test.ts:30-36`.
- **90-5** — the settings section. `ProfilePanel.tsx:1281` gates the whole away
  block on `systemIdleSupported()`, which is why Firefox sees nothing today; gate
  it on either source, show the pairing field and the connection state, and make
  the "chrome and edge only" copy at `:1297` stop being a lie. Keywords onto the
  `away` entry in `web/src/settings-nav.ts`.
- **90-6** — away delay as a real setting: `awayAfterMs` in `IdlePrefs`, default
  600_000 to match today, sent to the agent as `threshold` and passed to
  `IdleDetector` as `start({ threshold })` clamped to that API's 60s floor. This
  slice improves Chromium on its own, paired or not.
- **90-7** — packaging. Extend the `binaries` job in
  `.github/workflows/release.yml:98-160` rather than adding one — that workflow's
  header records the deliberate move to one `v*` tag and one version for
  everything. `chalkidle` for linux/darwin/windows × amd64/arm64, into the same
  `SHA256SUMS` and the same cosign signing loop. `chalkidle install` writes the
  systemd user unit, launchd plist or Startup entry, following the embedded
  template pattern in `internal/chalkctl/templates/`.

## Manual checklist

- [ ] **Dependency approval** for `godbus/dbus/v5` before 90-2.
- [ ] **WebKit and loopback.** Verify whether Safari permits an `http://127.0.0.1`
      fetch from an `https` document. If it does not, Safari is unreachable by
      this design and the doc says so plainly instead of implying coverage.
- [ ] **Brave.** scuq's own browser, and it farbles enough web APIs that
      `IdleDetector`'s availability there should be confirmed rather than
      assumed — it decides whether the agent is an upgrade or the only option on
      that browser. Related: `brave-deviceid-farbling`.
- [ ] **Chromium's local-network prompt** — confirm the preflight answer is
      accepted and note what the user actually sees, since the settings copy has
      to describe it.
- [ ] **Lock and unlock by hand** on each backend. The dot must go with no grace
      and return on the first input.
- [ ] **Away past the threshold with chalk focused and on screen** — the case no
      in-page rule can catch, and the reason this phase exists.
- [ ] **A wlroots session**, to confirm the lock-only degradation reads honestly
      in the settings panel rather than looking broken.

## Verification

```bash
go build ./... && go vet ./... && gofmt -l .
go test ./internal/idleagent/ ./internal/server/ ./internal/config/
cd web && npx tsc --noEmit && node test.mjs && node build.mjs
```

`internal/idleagent` carries the guards as tests, and they are the ones worth
writing first: a wrong `Origin` refused, a missing `Origin` refused, a rebound
`Host` refused, a wrong token refused in constant time, `0.0.0.0` never bound, the
token file created `0600`. `spa_test.go` pins both CSP shapes — unchanged when the
knob is empty, exactly one added source when it is set.

`agent-idle.test.ts` covers the pairing handshake, an unreachable agent resolving
to *absent* rather than hanging the cold load, the threshold hand-off, and the
`idleMs → idle` mapping at the boundary.

The rest needs the real thing: run `chalkidle` against the dev stack from the
`run-chalk` skill, on Firefox first, since Firefox is the browser this phase
exists for.

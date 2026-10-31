# Phase 128 — toolchain and dependency refresh

**Status:** all five slices built (2026-10-31). The phase shipped. These steps
passed on go1.27.3 for the first three slices:
`go build`, `go vet`, `gofmt -l`, the Go suite without the database
variables, `tsc --noEmit`, `node test.mjs`, `node build.mjs`, and a docker
build of `docker/Dockerfile`. With the database variables set, `internal/auth`
passed and `test/integration` failed 64 tests. The same 64 tests fail at HEAD
on go1.25.12 against the same dev database. The cause is the dev database,
not the toolchain: it does not contain the fixture users from
`fixtures/users.sql`. The test that looks for the bob fixture fails with
"not found". The same 64 tests failed the same way after 128-2, so the module
bumps did not change the result. Slice 128-5 passed the desktop chain
(`tsc --noEmit`, `node test.mjs`, `node build.mjs`).

**Tags:** `#toolchain` → `tools/where.sh -g toolchain`

## The problem

An audit on 2026-10-31 compared every pin against go.dev, proxy.golang.org,
npm, and releases.electronjs.org. Three build inputs were past end of life:

- Go 1.25. Only Go 1.27.3 and Go 1.26.10 receive security fixes.
- Node 20. It reached end of life on 2026-04-30.
- Alpine 3.20 in the dev image runtime stage.

Several modules and packages were also behind their latest release.

## The design

chalk refreshes pins by hand, in numbered slices. Each bump is verified and
recorded. One slice changes one kind of input.

128-1 changes the build toolchain only:

- `go.mod` moves from `go 1.25.12` to `go 1.27.3`. CI reads the Go version
  from `go.mod` (`go-version-file`), so `go.mod` is the single source.
- `docker/Dockerfile` and `docker/Dockerfile.dev` move from
  `golang:1.25-alpine` to `golang:1.27-alpine`.
- Both Dockerfiles move from `node:20-alpine` to `node:24-alpine`. The web job
  in `.github/workflows/ci.yml` moves `node-version` from '20' to '24'. The
  desktop job in the release workflow already used Node 24.
- The runtime stage of `docker/Dockerfile.dev` moves from `alpine:3.20` to
  `alpine:3.24`.
- The developer floor is Node 22, the oldest supported LTS. The build image
  uses Node 24. Node 22 is LTS until 2027-04-30, Node 24 until 2028-04-30.
  Node 26 became LTS on 2026-10-28.
- The production runtime `gcr.io/distroless/static-debian12:nonroot` does not
  change. It is still supported.

128-2 changes Go module pins only:

- `coder/websocket` moves from 1.8.13 to 1.8.15, `jackc/pgx/v5` from 5.9.2 to
  5.12.0, and `golang.org/x/crypto` from 0.51.0 to 0.58.0.
- `go mod tidy` moves four indirect modules: `jackc/puddle/v2` from 2.2.2 to
  2.2.3, `golang.org/x/sync` from 0.21.0 to 0.24.0, `golang.org/x/sys` from
  0.44.0 to 0.49.0, and `golang.org/x/text` from 0.39.0 to 0.43.0.
- `go-webauthn` does not change. Slice 128-3 moves it.
- pgx 5.12.0 (2026-10-30) fixes two high-severity vulnerabilities: SQL
  injection in simple-protocol batches (GHSA-j38q-h3ph-jjpq) and a bypass of
  `require_auth` and `channel_binding=require` (GHSA-95fj-3fxw-g62g). chalk
  uses no simple protocol, no batches, and neither setting. It was not exposed.
  It now carries the fixed version.

The review of chalk code covered three behavior changes in these releases.
None applies to chalk:

- pgx 5.11.0 and 5.12.0 require mocks of `pgx.Rows` and `BatchResults` to add
  `TypeMap` and `Tx`. chalk sets no `QueryExecMode`, calls no `SendBatch`, and
  has no custom `pgx.Rows` or `BatchResults` implementation.
- pgx 5.11.0 replaced the connection-URI parser with a parser that matches
  libpq exactly. The database URLs of `chalkctl` carry base64url passwords
  (letters, digits, `-`, and `_`), so the new parser accepts them unchanged.
- `coder/websocket` 1.8.14 changed the origin-scheme comparison. `websocket.Accept`
  in chalk sets only `Subprotocols`, so the change has no effect.

pgx 5.10.0 also hardened the binary decoders against malicious servers. pgx
5.11.0 changed text-format `timestamptz` scans to `time.Local`. Neither change
needed a code change in chalk.

The Go 1.26 and 1.27 release notes show nothing that touches chalk code
paths. These changes are worth knowing:

- `encoding/json` uses the json/v2 implementation. Behavior is preserved. A
  GODEBUG setting restores the old implementation.
- Timer channels are always unbuffered. The `asynctimerchan` setting is gone.
- Key generation in `crypto` always uses the operating system random source.
- TLS 1.2 is the minimum version, whatever the `go.mod` version is.

128-3 moves the passkey library only:

- `go-webauthn/webauthn` moves from 0.17.3 to 0.18.2. The indirect modules
  `go-webauthn/x` (0.2.5 to 0.3.1) and `fxamacker/cbor/v2` (2.9.2 to 2.9.4)
  follow. `descope/virtualwebauthn` 1.0.5 does not change.
- Version 0.18.0 (2026-08-27) has a `MIGRATION.md` with breaking changes.
  `go build` and `go vet` were clean with no code change. chalk sets only
  `RPID`, `RPDisplayName`, and `RPOrigins` on the config. It uses only the
  library option `WithAuthenticatorSelection`, so the change that lets an
  option return an error does not reach it. It passes no extensions and reads
  no extension outputs. It never imports the `metadata`, `webauthncose`, or
  `webauthncbor` packages. It stores credentials as explicit columns
  (`credential_id`, `public_key`, `sign_count`, `transports`, and flags), not
  as JSON. It keeps the ceremony `SessionData` only in the in-memory
  `CeremonyCache`. The changed `SessionData` shape and the new
  `Credential.Extensions` field therefore need no storage change.

The review covered four behavior changes. None needed a code change:

- The library now rejects an `RPID` that is not a domain string. The chalk
  default is `localhost`, and in production it equals the deployment domain from
  `chalkctl`. Both pass. An IP address as `RPID` now fails in `webauthn.New`,
  that is at `chalkd` startup, with a clear error.
- Registration now also rejects a credential that is not backup-eligible but
  reports itself backed up. The stored `UserVerified` flag latches on an
  assertion. The BE/BS persistence (migration 0042, `adoptLegacyFlags`) does
  not change. `TestSyncedPasskeyLoginEndToEnd` and
  `TestLegacyPasskeyFlagsAdoptedOnLogin` pass.
- A credential response must carry `rawId` equal to `id`. Browsers always send
  both.
- A ceremony that an older version serialized does not matter. Sessions live
  only in memory and end with the process.

One change is deliberate. By default, v0.18 rejects any client extension output
that the relying party did not request. chalk requests no extensions, but the
web client posts `getClientExtensionResults()` back unchanged. A third-party
passkey provider (a browser extension or a platform authenticator) can return
an output such as `credProps` unprompted. The default would fail the passkey
sign-in of that user and protect nothing, because chalk reads no outputs.
`internal/auth/service.go` therefore sets `ExtensionsUnsolicitedOutputPolicy`
to `protocol.UnsolicitedOutputPolicyIgnore` in the `webauthn.Config`.

Revisit this policy when chalk first requests and reads an extension. The
candidate is the PRF-based passkey KEK described in PHASE-31. Then restore the
recommended default, which rejects unsolicited outputs.

The new test `TestUnsolicitedExtensionOutputIsIgnored` in
`internal/auth/passkey_extensions_test.go` registers and then signs in with
`virtualwebauthn` responses. The `clientExtensionResults` of these responses
carry an unrequested `credProps` output. The test needs
`CHALK_TEST_DATABASE_URL`, like the other end-to-end tests. Without the policy
line it failed with status 400 and the message "Client returned the credProps
extension output which was not requested". With the policy line it passes.

The real-browser test passed on 2026-10-31. A Playwright probe ran against
the dev stack and used the Chromium virtual authenticator through the CDP
WebAuthn domain. It registered a user and added a passkey in the profile panel,
with a step-up that used the password and a TOTP code.
`/api/auth/passkeys/add/finish` returned 200. The probe signed out and signed
in with the passkey. `/api/auth/authenticate/finish` returned 200 with
`totp_required`. The probe then completed the TOTP step. Seven of seven steps
passed.

128-4 moves the npm pins only:

- In `web/`, `@mediapipe/tasks-vision` moves from 1.0.1 to 1.2.0. It is the
  segmentation runtime for the video background blur. Releases 1.1.0, 1.1.1,
  and 1.2.0 ship new WASM binaries and a JavaScript fix that prevents
  overlapping WASM embedding calls. `fake-indexeddb` moves from 6.2.5 to 6.2.7.
  It is used only in tests.
- `web/src/voice/camera-blur.ts` uses `FilesetResolver.forVisionTasks` and
  `ImageSegmenter.createFromOptions`. Both are unchanged. `web/build.mjs`
  copies `wasm/vision_wasm_internal.js` and `wasm/vision_wasm_internal.wasm`
  out of the package. Both files are still at those paths. The `mediapipe-<hash>`
  directory of the built bundle has a new hash, because the WASM changed.
- In `test/e2e/`, `@playwright/test` moves from 1.56.1 to 1.64.1, which bundles
  Chromium 156.0.8078.4. `typescript` moves from 5.6.3 to 7.0.2, the same
  version as in `web/`. `@types/node` moves from ^22 to ^24.19.2, which matches
  the Node 24 build image.
- `test/e2e/tsconfig.json` has one new line: `"types": ["node"]`. TypeScript 7
  no longer includes every installed `@types` package by itself. Without the
  line, `tsc --noEmit` reported TS2591 "Cannot find name 'process'" in every
  spec. TypeScript 5.6.3 passed with the old config.
- `npm audit` reports 0 vulnerabilities in `web/` and `test/e2e/`.

The web chain passed: `tsc --noEmit`, `node test.mjs`, and `node build.mjs`. A
docker build of `docker/Dockerfile` passed with the new lockfile. In
`test/e2e/`, `npx tsc --noEmit` passed after the `tsconfig.json` line. The Go
build, `go vet`, and `gofmt -l` did not change and are clean.

The e2e suite ran against the dev stack with Playwright 1.64.1. The result was
7 failed, 3 skipped, and 0 passed. This is the same state as before the bump.
The browser version is not the cause. The specs predate auth v2:

- `smoke.spec.ts` expects an unauthenticated status bar and never sees one.
- `mobile.spec.ts` throws on purpose at the sign-in card with "this spec needs
  an authenticated context".
- `channels.spec.ts` and `multitab.spec.ts` go to a hard-coded second instance
  at 127.0.0.1:38679. Nothing serves that address.
- `admin.spec.ts` skips if `CHALK_ADMIN_BOOTSTRAP_TOKEN` is not set.

The driver and probes in `.claude/skills/run-chalk/` are the working browser
path.

128-5 moves Electron only:

- In `desktop/`, `electron` moves from 43.4.1 to 45.2.1 (released 2026-10-30).
  The `allowScripts` key moves from `electron@43.4.1` to `electron@45.2.1`.
  Electron 45.2.1 embeds Chromium 156.0.8078.75 and Node 24.22.1. Electron
  43.4.1 had Chromium 150.0.7871.224 and Node 24.18.1. The 43 line is still
  patched at 43.8.6, but it loses support when Electron 46 ships. Electron 46
  is in alpha.
- `npm install` does not download the Electron binary while the `allowScripts`
  key names the old version, because the postinstall stays blocked until the
  key matches. Run `node node_modules/electron/install.js` by hand to get
  it. PHASE-104 notes the same step for other reasons.

The audit of the desktop lockfile had 8 findings before this slice. One of
them was Electron 43 itself. `npm audit fix` without `--force` moved the
transitive `brace-expansion` and `undici` inside the `@electron/packager`
tree. After the bump and the fix, 5 moderate findings remain. All are `glob`
and `minimatch` under `@electron/asar` inside `@electron/packager` 20.3.0. The
only fix that npm offers is a downgrade to `@electron/packager` 18.4.4, which
is a breaking change. The findings stay until the packager releases a version
with a newer `glob`. Both packages run only at packaging time on the release
runner. They are not in the shipped app. `npm audit` in `web/` and
`test/e2e/` still reports 0 vulnerabilities.

The review of the Electron 44 and 45 breaking changes against `desktop/src`
found that none applies:

- The sandboxed preload (`desktop/src/preload.ts`) uses no `Buffer`,
  `setImmediate`, or Node module shims. It uses only `process.argv` and
  `process.platform`, and both remain.
- Screen share goes through `setDisplayMediaRequestHandler` with
  `desktopCapturer` sources. Electron 45 did not change this flow.
  `display-capture` is already in the permission allowlist
  (`desktop/src/permissions.ts`).
- Every window is already sandboxed with `contextIsolation`. This includes the
  pop-out children from `setWindowOpenHandler`. The Electron 45 change that
  sandboxes the children of unsandboxed windows therefore does not reach
  chalk.
- chalk does not use `safeStorage`, the `clipboard` module, `net.request`, or
  `contentTracing`.
- Electron 44 dropped macOS 12, Windows ia32, Linux armv7l, and the Unity
  desktop. chalk targets none of them.

The desktop chain passed: `npx tsc --noEmit`, `node test.mjs` (63 passed, 0
failed), and `node build.mjs`. The Go build, `go vet`, and `gofmt -l` did not
change and are clean. The web chain did not change.

The real-shell probe ran on 2026-10-31. It used Playwright `_electron` with
the shell started with `--server http://localhost:8443` against the dev stack
and a new `XDG_CONFIG_HOME`. Six of six substantive tests passed:

- The runtime reported electron 45.2.1, chrome 156.0.8078.75, and node
  24.22.1.
- The shell loaded the sign-in card of the server.
- A user registered inside the shell through the full auth-v2 signup and
  reached the chat.
- The preload bridge was exposed under the sandbox.
- The Document Picture-in-Picture API was absent, so the 104-6 switch still
  works on Chromium 156.
- `window.open('', …, 'popup,width=420,height=320')`, the plain pop-up path of
  the call pop-out, opened a second shell window of 420×357.

The run logged one console error: a 404 on `/api/server-identity`. The server
answers 404 on purpose when it has no identity key configured, and the dev
stack has none. It is not an Electron matter.

## Slices

- 128-1 (built): Go 1.27.3 and Node 24 build toolchain, Alpine 3.24 dev
  image, docs updated.
- 128-2 (built): Go module bumps without breaking changes. `go mod tidy`
  updated the indirect modules.
- 128-3 (built): `go-webauthn/webauthn` to 0.18.2. This slice stands alone.
  The BE/BS flag handling (migration 0042, `adoptLegacyFlags`) and the rule
  that TOTP is mandatory on the passkey path do not change. The one policy
  change is `ExtensionsUnsolicitedOutputPolicy`, with a test.
- 128-4 (built): npm bumps in `web/` and `test/e2e/`. `npm audit` stays clean
  in both.
- 128-5 (built): Electron 43.4.1 to 45.2.1. The 43 line is still supported
  (43.8.6), but it loses support when Electron 46 ships. Electron 46 is in
  alpha. `docs/browser-support.md` now says Chromium 156.

## Versions

| Pin | Where | Before | After | Status |
|---|---|---|---|---|
| Go | `go.mod` | 1.25.12 | 1.27.3 | 128-1, built |
| Go image | `docker/Dockerfile`, `docker/Dockerfile.dev` | `golang:1.25-alpine` | `golang:1.27-alpine` | 128-1, built |
| Node image | `docker/Dockerfile`, `docker/Dockerfile.dev` | `node:20-alpine` | `node:24-alpine` | 128-1, built |
| Node in CI | `.github/workflows/ci.yml` | '20' | '24' | 128-1, built |
| Alpine runtime | `docker/Dockerfile.dev` | 3.20 | 3.24 | 128-1, built |
| `coder/websocket` | `go.mod` | 1.8.13 | 1.8.15 | 128-2, built |
| `jackc/pgx/v5` | `go.mod` | 5.9.2 | 5.12.0 | 128-2, built |
| `golang.org/x/crypto` | `go.mod` | 0.51.0 | 0.58.0 | 128-2, built |
| `jackc/puddle/v2` | `go.mod` | 2.2.2 | 2.2.3 | 128-2, built |
| `golang.org/x/sync` | `go.mod` | 0.21.0 | 0.24.0 | 128-2, built |
| `golang.org/x/sys` | `go.mod` | 0.44.0 | 0.49.0 | 128-2, built |
| `golang.org/x/text` | `go.mod` | 0.39.0 | 0.43.0 | 128-2, built |
| `go-webauthn/webauthn` | `go.mod` | 0.17.3 | 0.18.2 | 128-3, built |
| `go-webauthn/x` | `go.mod` | 0.2.5 | 0.3.1 | 128-3, built |
| `fxamacker/cbor/v2` | `go.mod` | 2.9.2 | 2.9.4 | 128-3, built |
| `@mediapipe/tasks-vision` | `web/package.json` | 1.0.1 | 1.2.0 | 128-4, built |
| `fake-indexeddb` | `web/package.json` | 6.2.5 | 6.2.7 | 128-4, built |
| `@playwright/test` | `test/e2e/package.json` | 1.56.1 | 1.64.1 | 128-4, built |
| `typescript` | `test/e2e/package.json` | 5.6.3 | 7.0.2 | 128-4, built |
| `@types/node` | `test/e2e/package.json` | 22 | ^24.19.2 | 128-4, built |
| Electron | `desktop/package.json` | 43.4.1 | 45.2.1 | 128-5, built |

These pins are current and do not change: `descope/virtualwebauthn` 1.0.5,
`google/uuid` 1.6.0, `esbuild` 0.28.2, `typescript` 7.0.2 in `web/`,
`hash-wasm` 4.12.0, `qrcode-generator` 2.0.4, and `@electron/packager` 20.3.0.

## Deferred

- Preact 10.29.8 to 11.1.1. It is a major release that touches every
  component. It gets its own phase after someone reads its migration guide.
- `gcr.io/distroless/static-debian13`. The image exists, but it has no
  security driver now.
- Node 26 as the build image. Wait until it has several patch releases.
- The `test/e2e` suite. Its specs predate auth v2 (see the 128-4 block). It
  needs a revival.
- The 5 moderate `npm audit` findings in `desktop/` under `@electron/packager`.
  They stay until a packager release moves off the old `glob` and `minimatch`.

## Rejected

- Go 1.26.10. It is supported, but it reaches end of life in six months.
- Dependabot. Hand-made slices let chalk verify and record each bump.

## Manual checklist

128-1 leaves no open item in the code. One effect is not an error: the first
`go build` on a machine with `GOTOOLCHAIN=auto` downloads Go 1.27.3. That
download can take some time.

Open: run `test/integration` again on go1.27.3 against a database seeded with
`fixtures/users.sql`. Until then, the DB-backed integration result is not
known for this toolchain.

128-3 leaves no open item. The real-browser test is done. The 128-3 block in
the design section records it.

128-4 leaves no open item.

128-5 leaves no open item. The probe found nothing to follow up. The verification of
shaped windows on macOS and Windows from 104-6 does not change. It belongs to
phase 104, not to this phase.

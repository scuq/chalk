# Phase 128 — toolchain and dependency refresh

**Status:** 128-1, 128-2, and 128-3 built (2026-10-31). These steps passed on
go1.27.3 for all three slices:
`go build`, `go vet`, `gofmt -l`, the Go suite without the database
variables, `tsc --noEmit`, `node test.mjs`, `node build.mjs`, and a docker
build of `docker/Dockerfile`. With the database variables set, `internal/auth`
passed and `test/integration` failed 64 tests. The same 64 tests fail at HEAD
on go1.25.12 against the same dev database. The cause is the dev database,
not the toolchain: it does not contain the fixture users from
`fixtures/users.sql`. The test that looks for the bob fixture fails with
"not found". The same 64 tests failed the same way after 128-2, so the module
bumps did not change the result. Slices 128-4 and 128-5 are planned, not
started.

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

## Slices

- 128-1 (built): Go 1.27.3 and Node 24 build toolchain, Alpine 3.24 dev
  image, docs updated.
- 128-2 (built): Go module bumps without breaking changes. `go mod tidy`
  updated the indirect modules.
- 128-3 (built): `go-webauthn/webauthn` to 0.18.2. This slice stands alone.
  The BE/BS flag handling (migration 0042, `adoptLegacyFlags`) and the rule
  that TOTP is mandatory on the passkey path do not change. The one policy
  change is `ExtensionsUnsolicitedOutputPolicy`, with a test.
- 128-4 (planned): npm minor bumps. `npm audit` must stay clean in `web/` and
  `test/e2e/`.
- 128-5 (planned): Electron 43.4.1 to 45.2.1. The 43 line is still supported
  (43.8.6), but it loses support when Electron 46 ships. Electron 46 is in
  alpha. `docs/browser-support.md` must then say Chromium 156.

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
| `@mediapipe/tasks-vision` | `web/package.json` | 1.0.1 | 1.2.0 | 128-4, planned |
| `fake-indexeddb` | `web/package.json` | 6.2.5 | 6.2.7 | 128-4, planned |
| `@playwright/test` | `test/e2e/package.json` | 1.56.1 | 1.64.1 | 128-4, planned |
| `typescript` | `test/e2e/package.json` | 5.6.3 | 7.0.2 | 128-4, planned |
| `@types/node` | `test/e2e/package.json` | 22 | 24 | 128-4, planned |
| Electron | `desktop/package.json` | 43.4.1 | 45.2.1 | 128-5, planned |

These pins are current and do not change: `descope/virtualwebauthn` 1.0.5,
`google/uuid` 1.6.0, `esbuild` 0.28.2, `typescript` 7.0.2 in `web/`,
`hash-wasm` 4.12.0, `qrcode-generator` 2.0.4, and `@electron/packager` 20.3.0.

## Deferred

- Preact 10.29.8 to 11.1.1. It is a major release that touches every
  component. It gets its own phase after someone reads its migration guide.
- `gcr.io/distroless/static-debian13`. The image exists, but it has no
  security driver now.
- Node 26 as the build image. Wait until it has several patch releases.

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

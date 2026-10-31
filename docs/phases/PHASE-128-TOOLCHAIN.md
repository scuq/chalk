# Phase 128 — toolchain and dependency refresh

**Status:** 128-1 built (2026-10-31). These steps passed on go1.27.3:
`go build`, `go vet`, `gofmt -l`, the Go suite without the database
variables, `tsc --noEmit`, `node test.mjs`, `node build.mjs`, and a docker
build of `docker/Dockerfile`. With the database variables set, `internal/auth`
passed and `test/integration` failed 64 tests. The same 64 tests fail at HEAD
on go1.25.12 against the same dev database. The cause is the dev database,
not the toolchain: it does not contain the fixture users from
`fixtures/users.sql`. The test that looks for the bob fixture fails with
"not found". Slices 128-2 to 128-5 are planned, not started.

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

The Go 1.26 and 1.27 release notes show nothing that touches chalk code
paths. These changes are worth knowing:

- `encoding/json` uses the json/v2 implementation. Behavior is preserved. A
  GODEBUG setting restores the old implementation.
- Timer channels are always unbuffered. The `asynctimerchan` setting is gone.
- Key generation in `crypto` always uses the operating system random source.
- TLS 1.2 is the minimum version, whatever the `go.mod` version is.

## Slices

- 128-1 (built): Go 1.27.3 and Node 24 build toolchain, Alpine 3.24 dev
  image, docs updated.
- 128-2 (planned): Go module bumps without breaking changes. `go mod tidy`
  updates the indirect modules.
- 128-3 (planned): `go-webauthn/webauthn` to 0.18.2. This slice stands alone.
  Version 0.18.0 (2026-08-27) has large breaking changes, listed in the
  library file `MIGRATION.md`. It also adds ML-DSA support on Go 1.27. The
  slice must keep the BE/BS flag handling (migration 0042,
  `adoptLegacyFlags`) and the rule that TOTP is mandatory on the passkey path.
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
| `coder/websocket` | `go.mod` | 1.8.13 | 1.8.15 | 128-2, planned |
| `jackc/pgx/v5` | `go.mod` | 5.9.2 | 5.12.0 | 128-2, planned |
| `golang.org/x/crypto` | `go.mod` | 0.51.0 | 0.58.0 | 128-2, planned |
| `go-webauthn/webauthn` | `go.mod` | 0.17.3 | 0.18.2 | 128-3, planned |
| `go-webauthn/x` | `go.mod` | 0.2.5 | 0.3.1 | 128-3, planned |
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

# Phase 108 — the image cross-compiles

**Status:** built, 108-1, 2026-08-29. Shipped with v0.8.10.

**Tag:** `#image` → `tools/where.sh -g image`

## The problem

The container image is built for `linux/amd64` and `linux/arm64` in one
`docker/build-push-action` step, and the Dockerfile ran every stage
*natively per platform*: on the amd64 runner the arm64 half executed
`node:20-alpine` (npm ci, esbuild) and `golang:1.25-alpine` (go build) under
QEMU user emulation. That worked, slowly, for months. On 29 August 2026 it
stopped: v0.8.8's image job took seven minutes at 11:30, and v0.8.9's run at
12:47 — same Dockerfile, same workflow — hung. The job log shows where:

```
#32 [linux/arm64 frontend 4/6] RUN npm ci --prefer-offline --no-audit || npm install
#32 13.15 qemu: uncaught target signal 4 (Illegal instruction) - core dumped
#32 30.00 qemu: uncaught target signal 4 (Illegal instruction) - core dumped
```

and then nothing for two hours: node's child crashed under the emulator, npm
never returned, so the `|| npm install` fallback never ran either, and the
job had no `timeout-minutes`, so GitHub would have let it sit for six. Both
the push run and a manual dispatch went the same way; v0.8.9 never
published (the tag exists, the release does not).

What changed between 11:30 and 12:47 was not in this repository. The
workflow pulls `node:20-alpine` fresh (`pull: true`) and
`docker/setup-qemu-action` installs `tonistiigi/binfmt:latest`; either a
node image rebuild or a newer QEMU is enough for V8's JIT to hit an
instruction the emulator rejects. Which one is not worth finding out,
because the emulation was never needed.

## The design

Nothing chalk runs at build time depends on the target architecture. The
SPA bundle is JavaScript and CSS; Go cross-compiles with two environment
variables. So every stage that executes anything now runs on the build
machine's own platform, and only the final distroless stage — which runs
nothing — is per target:

```dockerfile
FROM --platform=$BUILDPLATFORM node:20-alpine AS frontend      # once
FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS build     # once per target
ARG TARGETOS=linux
ARG TARGETARCH
... GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build ...
FROM gcr.io/distroless/static-debian12:nonroot                 # per target, no RUN
```

`TARGETARCH` defaults to the host's own arch when unset, so a plain
`docker build` on a laptop still works. The build-stage smoke test
(`/out/chalkd --version`) only runs when target and host arch match — running
a foreign binary would need the emulator back; for the cross case the stage
checks the artifact instead (`go version -m` reports `GOARCH=<target>`).

`timeout-minutes: 30` on the image job turns the next hang, whatever its
cause, into a failed job within half an hour — which `gh run rerun --failed`
can pick up — instead of a six-hour wait.

### Rejected

- **Pinning the QEMU image** (`setup-qemu-action` with
  `image: tonistiigi/binfmt:qemu-v7.0.0`). Treats the symptom; the next
  node image rebuild can bring it back, and the arm64 build stays several
  times slower than it needs to be.
- **Dropping the QEMU setup step.** It is now unused, but leaving it costs
  nothing and keeps a future `RUN` in the runtime stage from failing in a
  confusing new way. Cleanup for another day.
- **Running the cross-compiled binary through QEMU for the smoke test.** A
  static Go binary printing a version is a small surface, but it is the same
  emulator that just hung the release; not worth it for a check the
  `go version -m` line covers.

## Slices

- **108-1 — cross-compile.** Built. `docker/Dockerfile` as above;
  `timeout-minutes: 30` on the `image` job in `.github/workflows/release.yml`.
  Verified locally from this arm64 box: `docker buildx build --platform
  linux/amd64` produces an x86-64 `chalkd` with node and Go running natively
  (no binfmt registered here, so emulation would have failed outright), and
  the native arm64 build still runs its `--version` check.

## Where it lives

`docker/Dockerfile`, `.github/workflows/release.yml` (the `image` job).

## Verification

The v0.8.10 release run is the real test: the image job should be back
around seven minutes, with the arm64 stages no longer in the log at all
except the final `COPY`.

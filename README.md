# chalk

End-to-end encrypted group chat. Single Go binary, Postgres, browser client. Matrix-green-on-black, themeable, Hack font, Slack-style threading.

## Status

Early scaffold. Built phase-by-phase via `bootstrap/` scripts. Each phase is idempotent, self-tested, and resumable.

| Phase | Status | What it adds |
|---|---|---|
| 00 init | ✅ implemented | Repo scaffolding, hooks, lib helpers |
| 01 go-skeleton | ✅ implemented | `chalkd` binary skeleton, config, version |
| 02 container | ✅ implemented | Dockerfile, compose, healthcheck |
| 03 postgres | ⏳ stub | pgx pool, migrations, store |
| 04 ws-relay | ⏳ stub | WebSocket hub, plaintext echo |
| 05 pubsub | ⏳ stub | LISTEN/NOTIFY fan-out |
| 06 presence | ⏳ stub | Multi-device presence with TTL |
| 07 frontend-shell | ⏳ stub | Theming, Hack, sounds, roster, composer |
| 08 channels | ⏳ stub | Channels, threading |
| 09 blobs | ⏳ stub | Encrypted attachments (AES-256-GCM) |
| 10 mls | ⏳ stub | CoreCrypto WASM, MLS groups |
| 11 friending | ⏳ stub | Friend requests, encrypted presence |
| 12 hardening | ⏳ stub | Rate limits, metrics, GC |
| 13 cross-browser | ⏳ stub | Playwright matrix, mobile emulation |

## Quick start

Requirements: Go 1.23+, Docker 24+, Bash 5.2+, `make`, `git`.

```sh
git clone https://github.com/scuq/chalk
cd chalk
bootstrap/run-all.sh    # runs every implemented phase, idempotent
make run                # starts chalkd locally on :8443
```

Visit `https://localhost:8443/healthz` (you'll need to accept the self-signed cert in dev).

## Architecture

See [docs/architecture.md](docs/architecture.md). One-line summary:

> Multi-instance Go server using Postgres as both storage and pub/sub bus (LISTEN/NOTIFY). Browser client speaks MLS (RFC 9420) for E2E group encryption via WASM. Server only ever sees ciphertext, routing metadata, and coarse presence.

## License

MIT — see [LICENSE](LICENSE).

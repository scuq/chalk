# chalk

End-to-end encrypted group chat. Single Go binary, Postgres, browser client. Matrix-green-on-black, themeable, Hack font, Slack-style threading.

## Status

Built phase-by-phase via `bootstrap/` scripts and (from phase 09 onward) tarball patches. Each phase is idempotent, self-tested, and resumable. Phases 00–09 are shipped and working: multi-channel chat with cross-instance fan-out, named participants, passkey auth, invites, admin moderation. End-to-end encryption (phase 10) is the next big chunk of work; chalkd currently carries plaintext over the wire.

| Phase | Status | What it adds |
|---|---|---|
| 00 init | ✅ shipped | Repo scaffolding, hooks, lib helpers |
| 01 go-skeleton | ✅ shipped | `chalkd` binary skeleton, config, version |
| 02 container | ✅ shipped | Dockerfile, compose, healthcheck |
| 03 postgres | ✅ shipped | pgx pool, migrations, store (users, devices) |
| 04 ws-relay | ✅ shipped | WebSocket hub, hello/welcome, plaintext send/message |
| 05 pubsub | ✅ shipped | LISTEN/NOTIFY fan-out across instances |
| 06 presence | ✅ shipped | Multi-device presence with TTL + friends |
| 07 frontend-shell | ✅ shipped | Preact + esbuild SPA, Matrix theme, dev workflow |
| 08 channels | ✅ shipped | Per-channel pubsub, DM cardinality, fetch_history |
| 08b channels-spa | ✅ shipped | Sidebar, create modal, friend picker, subscribe_channel |
| 08c handles | ✅ shipped | `you (alice)`, `@bob`, named DMs and friend picker |
| 09 auth | ✅ shipped | Passkeys (WebAuthn), 24-word recovery codes, invites, profile, email-change, admin moderation |
| 10 mls | 🔮 planned | CoreCrypto WASM, MLS groups (RFC 9420) |
| 11 lifecycle | 🔮 planned | Account deactivate/delete/reactivate write paths |
| 12 blobs | 🔮 planned | Encrypted attachments (AES-256-GCM) |
| 13 hardening | 🔮 planned | Rate limits, metrics, GC, `--migrate-only` |
| 14 cross-browser | 🔮 planned | Playwright matrix, mobile emulation |

Phase numbering reflects the current plan and differs from the original scaffold (which had 09=blobs, 10=mls). Phase 09 was delivered as a sequence of patches (09a, 09b, 09c, 09d) rather than the single scaffolded `phase-09-*.sh` stub; see `docs/phase-log.md` for the breakdown.

## Quick start

Requirements: Go 1.23+, Docker 24+, Bash 5.2+, `make`, `git`, Node 18+.

```sh
git clone https://github.com/scuq/chalk
cd chalk
make dev                # brings up Postgres + chalkd + SPA, foreground
```

Then open <http://127.0.0.1:8443/> in a browser. The dev workflow seeds three users (alice, bob, carol) and an alice<->bob friendship so you can immediately create a DM via the "+" button.

For the full validated phase-by-phase build:

```sh
bootstrap/run-all.sh    # runs every implemented phase, idempotent
make build              # build the chalkd binary
```

## Architecture

See [docs/architecture.md](docs/architecture.md). One-line summary:

> Multi-instance Go server using Postgres as both storage and pub/sub bus (LISTEN/NOTIFY). Browser client speaks MLS (RFC 9420) for E2E group encryption via WASM. Server only ever sees ciphertext, routing metadata, and coarse presence.

(MLS lands in phase 10. Phases 00–09 use plaintext over the wire.)

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).

chalk was previously distributed under the MIT License through the 9.x phase series; the project was relicensed in phase 11a by the sole copyright holder to align with @wireapp/core-crypto.
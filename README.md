# chalk

End-to-end encrypted group chat. Single Go binary, Postgres, browser client. Matrix-green-on-black, themeable, Hack font, Slack-style threading.

## Status

Built phase-by-phase via `bootstrap/` scripts and (from phase 09 onward) tarball patches. Each phase is idempotent, self-tested, and resumable. Phases 00–11b are shipped and working: multi-channel chat with cross-instance fan-out, named participants, passkey auth, invites, admin moderation, and MLS-encrypted DMs (single-device). Phase 11d (multi-device + history transfer) is fully designed in `docs/design/`; implementation pending.

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
| 11a CoreCrypto | ✅ shipped | `@wireapp/core-crypto` WASM integration, KeyPackage publish/fetch, license change to GPL-3.0-or-later |
| 11b MLS DM encryption | ✅ shipped | End-to-end encrypted DMs between two single-device users (alice2↔bob2), `mls_ciphertext` content type, server stores opaque MLS bytes only |
| 11c channel encryption | 🔮 planned | MLS for multi-member channels (extends 11b beyond DMs) |
| 11d multi-device + history | 📐 designed | Multi-device sync + history transfer for MLS DMs. See `docs/design/phase-11d-doc{1..7}.md` |
| 12 lifecycle | 🔮 planned | Account deactivate/delete/reactivate write paths |
| 13 blobs | 🔮 planned | Encrypted attachments (AES-256-GCM) |
| 14 hardening | 🔮 planned | Rate limits, metrics, GC, `--migrate-only` |
| 15 cross-browser | 🔮 planned | Playwright matrix, mobile emulation |

Phase numbering reflects the current plan and differs from the original scaffold (which had 09=blobs, 10=mls). Phase 09 was delivered as a sequence of patches (09a, 09b, 09c, 09d); phase 11 has been broken into 11a (CoreCrypto), 11b (MLS DMs, in three sub-phases 11b-1/2/3), 11c (channels), and 11d (multi-device). See `docs/phase-log.md` for the canonical history and `CHANGELOG.md` for the per-release log.

## Quick start

Requirements: Go 1.23+, Docker 24+, Bash 5.2+, `make`, `git`, Node 18+.

```sh
git clone https://github.com/scuq/chalk
cd chalk
make dev                # brings up Postgres + chalkd + SPA, foreground
```

Then open <http://127.0.0.1:8443/> in a browser. The dev workflow seeds three users (alice, bob, carol) and an alice<->bob friendship so you can immediately create a DM via the "+" button. For MLS-encrypted DMs (phase 11b), use the `alice2` / `bob2` fixture users that have completed phase-11a KeyPackage publishing.

For the full validated phase-by-phase build:

```sh
bootstrap/run-all.sh    # runs every implemented phase, idempotent
make build              # build the chalkd binary
```

## Architecture

See [docs/architecture.md](docs/architecture.md). One-line summary:

> Multi-instance Go server using Postgres as both storage and pub/sub bus (LISTEN/NOTIFY). Browser client speaks MLS (RFC 9420) for E2E group encryption via WASM. Server only ever sees ciphertext, routing metadata, and coarse presence.

(MLS shipped for DMs in phases 11a/11b. Multi-member channels and multi-device support are forthcoming in 11c and 11d respectively.)

## Design documents

For implementation-depth specs of the phase-11d design (multi-device + history transfer):

- [docs/design/phase-11d-doc1-threat-model.md](docs/design/phase-11d-doc1-threat-model.md) — threat model, crypto primitives, security considerations
- [docs/design/phase-11d-doc2-wire-protocol.md](docs/design/phase-11d-doc2-wire-protocol.md) — 32+ new wire frames across 6 families
- [docs/design/phase-11d-doc3-serialization.md](docs/design/phase-11d-doc3-serialization.md) — HistorySecret encrypted-payload format
- [docs/design/phase-11d-doc4-server-schema.md](docs/design/phase-11d-doc4-server-schema.md) — `backup_envelopes`, `history_secrets`, `critical_events` tables
- [docs/design/phase-11d-doc5-client-state-machines.md](docs/design/phase-11d-doc5-client-state-machines.md) — nine client flows
- [docs/design/phase-11d-doc6-pairing.md](docs/design/phase-11d-doc6-pairing.md) — online device-to-device pairing
- [docs/design/phase-11d-doc7-migration-and-test-plan.md](docs/design/phase-11d-doc7-migration-and-test-plan.md) — landing sequence + verification matrix

## License

GPL-3.0-or-later — see [LICENSE](LICENSE).

chalk was previously distributed under the MIT License through the 9.x phase series; the project was relicensed in phase 11a by the sole copyright holder to align with @wireapp/core-crypto.

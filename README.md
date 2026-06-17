# chalk

A self-hosted group chat: single Go binary, Postgres, browser client.
Matrix-green-on-black, themeable, Hack font, Slack-style threading.
Passkey-only auth (no passwords).

> **Crypto status.** chalk is currently a **plaintext** group chat. It
> previously used MLS for end-to-end encryption; that was removed in the
> 21-series rework, and a new design (identity-wrapped space keys, native
> WebCrypto) is being built from phase 22 onward. Until that lands and is
> verified, **the server can read message content** — don't treat chalk as
> private yet. See `docs/threat-model.md` for the honest current state and
> the planned guarantees.

## Quick start

Requirements: Go 1.25+, Docker 24+, Bash 5.2+, `make`, `git`, Node 18+.

```sh
git clone https://github.com/scuq/chalk
cd chalk
make dev          # Postgres + chalkd + SPA, foreground on :8443
```

Then open <http://127.0.0.1:8443/>. On first run the server prints an
**admin bootstrap URL** (valid 24h) — open it to register the admin user's
passkey. Additional users self-register through the signup flow in the SPA.
To test a two-user flow, register a second account in another browser
profile (or a private window) and add them as a friend from the first.

Stop with Ctrl-C; `make dev-down` removes the Postgres container.

## Architecture

See [docs/architecture.md](docs/architecture.md). In short: a stateless
multi-instance Go server using Postgres as both storage and pub/sub bus
(LISTEN/NOTIFY), with a Preact browser client over a JSON WebSocket
protocol ([docs/wire-protocol.md](docs/wire-protocol.md)). Each instance
holds only in-memory socket state; Postgres is the source of truth.

## Documentation

- [docs/architecture.md](docs/architecture.md) — system overview
- [docs/wire-protocol.md](docs/wire-protocol.md) — the `chalk.v1` WebSocket protocol
- [docs/threat-model.md](docs/threat-model.md) — current state + planned guarantees
- [docs/browser-support.md](docs/browser-support.md) — supported engines + minimum versions
- [docs/deployment.md](docs/deployment.md) — running it in production
- [docs/theming.md](docs/theming.md), [docs/notification-sounds.md](docs/notification-sounds.md) — client customization
- [docs/phase-log.md](docs/phase-log.md) — the build history (what shipped, when) and roadmap
- [docs/design/](docs/design/) — design specs for in-flight work (currently the crypto rebuild plan)

The phase-by-phase build history and the current roadmap live in
[docs/phase-log.md](docs/phase-log.md); per-release notes are in
[CHANGELOG.md](CHANGELOG.md). (This README intentionally doesn't track
phase status — see those instead.)

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Earlier 9.x-series releases were
distributed under the MIT License; the project was relicensed to
GPL-3.0-or-later by its sole copyright holder. Pre-relicense commits remain
available under their original MIT terms.

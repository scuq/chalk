# chalk

A self-hosted group chat: single Go binary, Postgres, browser client.
Matrix-green-on-black, themeable, Hack font, Slack-style threading.
Passkey-only auth (no passwords).

> **Crypto status.** chalk is **end-to-end encrypted**. Messages and
> attachments are encrypted client-side under per-channel space keys
> (identity-wrapped, native WebCrypto, AES-256-GCM); the server is a blind
> relay that stores only ciphertext. The encryption stack was rebuilt across
> phases 22–25 after the earlier MLS implementation was removed in the
> 21-series rework. See `docs/threat-model.md` for the guarantees and the
> metadata the server still sees.

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

## Cryptography in a nutshell

In one breath: you log in with a passkey (no password), you get a 24-word
phrase that is the seed of your cryptographic identity, and that identity
locks your messages so only the people in a space can read them. **All of
it is live — messages and attachments are end-to-end encrypted, and the
server stores only ciphertext.** Here is every piece in plain language.

| Piece | What it does, plainly | Status |
|---|---|---|
| Passkeys (WebAuthn) | Log in with your device's fingerprint/PIN instead of a password. Your device keeps the secret key; the server only ever sees a public key. Can't be phished. | live |
| Argon2id | The 24-word recovery phrase is never stored — only a slow, salted hash of it is, so a stolen database can't reveal it. | live |
| TLS 1.3 | Encrypts the connection between your browser and the server, like every HTTPS site. | live |
| 24-word phrase (BIP-39) | 256 bits of randomness written as 24 ordinary words, with a built-in checksum so a typo is caught. This is the root of your identity and your way back in on a new device. | live |
| PBKDF2-HMAC-SHA512 | Stretches those 24 words into a 64-byte seed (the standard BIP-39 step). | live |
| HKDF-SHA256 | Splits that one seed into two separate keys so the signing key and the encryption key are independent. | live |
| X25519 | Your encryption keypair. Two people's X25519 keys can agree on a shared secret without ever sending it — that secret wraps the keys that lock a space's messages. | live |
| Ed25519 | Your signing keypair. Proves "this identity really is mine," and signs the X25519 key so the server can't quietly swap it (the self-signature). | live |
| Self-signature | Your Ed25519 key signs your X25519 key. When someone fetches your identity, they check this signature, so a malicious server can't substitute a fake encryption key undetected. | live |
| Space keys + AES-256-GCM | Each space (group) has one shared symmetric key that actually encrypts the messages. It's handed to each member by wrapping it under their X25519 public key. | live |
| Picture-word verification | An out-of-band check (you compare the same picture/words with someone) to be sure no one is sitting in the middle swapping keys. | live |
| Phrase rotation + recovery | You can roll your phrase to a fresh one; old keys are re-wrapped so you keep your history, with an opt-out for when you're rotating because the old phrase leaked. | live |

A few deliberate choices worth knowing: every primitive above is **native
WebCrypto** — chalk bundles no cryptography library and ships no WASM. The
24-word phrase is the one and only decryption secret (no extra passphrase),
so guard it like a wallet seed: lose it and lose those messages, leak it and
leak them. And two things are explicit **non-goals**, not oversights:
forward secrecy (old messages staying safe if a key later leaks) and
post-quantum resistance. The full reasoning, threat model, and recovery
design live in [docs/threat-model.md](docs/threat-model.md) and
[docs/design/](docs/design/).

## Documentation

- [docs/architecture.md](docs/architecture.md) — system overview
- [docs/wire-protocol.md](docs/wire-protocol.md) — the `chalk.v1` WebSocket protocol
- [docs/threat-model.md](docs/threat-model.md) — current state + planned guarantees
- [docs/browser-support.md](docs/browser-support.md) — supported engines + minimum versions
- [docs/deployment.md](docs/deployment.md) — running it in production
- [docs/theming.md](docs/theming.md), [docs/notification-sounds.md](docs/notification-sounds.md) — client customization
- [docs/phase-log.md](docs/phase-log.md) — the build history (what shipped, when) and roadmap
- [docs/design/](docs/design/) — design specs (multi-device, the phase-30 voice/video plan, and historical crypto-rebuild notes)

The phase-by-phase build history and the current roadmap live in
[docs/phase-log.md](docs/phase-log.md); per-release notes are in
[CHANGELOG.md](CHANGELOG.md). (This README intentionally doesn't track
phase status — see those instead.)

## License

BSD-3-Clause — see [LICENSE](LICENSE).

chalk's licensing has changed over its life: MIT through the 9.x series,
then GPL-3.0-or-later in phase 11a to align with the (now-removed)
@wireapp/core-crypto dependency, and — with that dependency gone after the
21-series rip-out — back to the permissive BSD-3-Clause. Relicensing was
done by the sole copyright holder; commits remain available under whichever
license was in effect when they were made.

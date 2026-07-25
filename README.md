# chalk

A self-hosted, end-to-end-encrypted group chat: one Go binary, Postgres, and a
browser client. Matrix-green-on-black by default (seven themes, Hack font),
Slack-style threading, Discord-style voice/video rooms.

Accounts are password + TOTP; passkeys are an optional convenience on top,
never a bypass of the second factor.

> **Crypto status.** chalk is **end-to-end encrypted**. Messages, edits,
> reactions and attachments are encrypted client-side under per-channel space
> keys (identity-wrapped, native WebCrypto, AES-256-GCM); the server is a blind
> relay that stores only ciphertext. See [docs/threat-model.md](docs/threat-model.md)
> for the guarantees and the metadata the server still sees.

## What's in it

- **Messaging** — channels, DMs and threads; replies; @mentions; per-user
  unread tracking with a new-messages divider, synced across your devices.
- **Message actions** — react with emoji, edit your own message within 15
  minutes (marked `(edited)`), and delete under per-channel rules: your own
  words are always yours to retract, someone else's are the channel owner's
  call in dictator mode or a vote in democratic mode.
- **Attachments & GIFs** — encrypted uploads with encrypted previews,
  drag-drop / clipboard paste, and Giphy behind a per-user opt-in.
- **Voice & video** — voice channels with a WebRTC mesh, coturn as the
  mandatory relay, screen/game sharing and adaptive quality. Off by default
  (`CHALK_VOICE_ENABLED`).
- **Governance** — each channel is `dictator` or `democratic`; membership
  changes, deletions and mode changes can run as proposals the members vote on.
- **Accounts** — password + mandatory TOTP, optional passkeys, two separate
  24-word phrases (one resets your login, one is your encryption identity),
  and multi-device onboarding by re-entering the encryption phrase.
- **Client** — desktop and mobile layouts, installable as a PWA, seven themes,
  per-device font and text-size settings, per-user nick colours.
- **Ops** — `chalkctl` deploys and updates a whole host from cosign-verified
  container images.

## Quick start (development)

Requirements: Go 1.25+, Node 20+, Docker 24+, Bash 5.2+, `make`, `git`.

```sh
git clone https://github.com/scuq/chalk
cd chalk
make dev          # Postgres + chalkd + SPA, foreground on :8443
```

Then open <http://127.0.0.1:8443/> and sign up: pick a handle, set a password
(at least 20 characters across 4 character classes), scan the TOTP QR code, and
write down both 24-word phrases. To test a two-user flow, register a second
account in another browser profile (or a private window) and add them as a
friend from the first.

Stop with Ctrl-C; `make dev-down` removes the Postgres container.

To take the reserved admin account, set `CHALK_ADMIN_USERNAME`,
`CHALK_ADMIN_EMAIL` and `CHALK_ADMIN_BOOTSTRAP_TOKEN` before starting, then
open `/?admin_token=<token>` and complete signup. The claim is one-shot: once
the admin account has credentials, the URL does nothing.

## Deploying it

`chalkctl` is the deployment manager — one binary that installs and runs a
whole chalk host:

```sh
chalkctl init      # verify + pin the image, render config, bring everything up
chalkctl status    # deployed version, digest, service states
chalkctl update    # verify, swap, health-check, roll back on failure
```

It renders podman Quadlet units for chalkd, Postgres and coturn, sets up Caddy
for TLS, verifies GHCR pulls with cosign, and installs a weekly update timer.
See [docs/deployment.md](docs/deployment.md).

## Architecture

See [docs/architecture.md](docs/architecture.md). In short: a stateless
multi-instance Go server using Postgres as both storage and pub/sub bus
(LISTEN/NOTIFY), with a Preact browser client over a JSON WebSocket
protocol ([docs/wire-protocol.md](docs/wire-protocol.md)). Each instance
holds only in-memory socket state; Postgres is the source of truth.

## Accounts and cryptography in a nutshell

In one breath: you log in with a password and a 6-digit TOTP code, you hold a
separate 24-word phrase that is the seed of your cryptographic identity, and
that identity locks your messages so only the people in a channel can read
them. **All of it is live — messages and attachments are end-to-end encrypted,
and the server stores only ciphertext.** Here is every piece in plain language.

| Piece | What it does, plainly | Status |
|---|---|---|
| Password + Argon2id | Your password never leaves the browser. It is stretched with Argon2id (256 MiB, 3 passes) into a master key; the server only ever sees a derived proof value, and stores only a hash of that. | live |
| TOTP (RFC 6238) | A 6-digit code from your authenticator, required on **every** login — including the passkey path. Mandatory, not optional. | live |
| Passkeys (WebAuthn) | Optional convenience: unlock with your device's fingerprint/PIN instead of typing the password. Still asks for the TOTP code, so a stolen device is not an account. | live |
| Recovery phrase (24 words) | Your way back into the account if you forget the password. It **resets** your login rather than logging you in, and the server stores only a slow Argon2id hash of it. | live |
| Encryption phrase (24 words, BIP-39) | A second, separate phrase: 256 bits of randomness with a checksum, and the root of your cryptographic identity. Never leaves your browser; it is what lets a new device read your history. | live |
| PBKDF2-HMAC-SHA512 | Stretches those 24 words into a 64-byte seed (the standard BIP-39 step). | live |
| HKDF-SHA256 | Splits one seed into independent keys, so the signing key and the encryption key never overlap. | live |
| X25519 | Your encryption keypair. Two people's X25519 keys can agree on a shared secret without ever sending it — that secret wraps the keys that lock a channel's messages. | live |
| Ed25519 | Your signing keypair. Proves "this identity really is mine," and signs the X25519 key so the server can't quietly swap it (the self-signature). | live |
| Self-signature | Your Ed25519 key signs your X25519 key. When someone fetches your identity, they check this signature, so a malicious server can't substitute a fake encryption key undetected. | live |
| Space keys + AES-256-GCM | Each channel has one shared symmetric key that actually encrypts the messages, edits, reactions and attachments. It's handed to each member by wrapping it under their X25519 public key, and rotated when someone is removed. | live |
| Picture-word verification | An out-of-band check (you compare the same picture/words with someone) to be sure no one is sitting in the middle swapping keys. | live |
| Phrase rotation + recovery | You can roll your encryption phrase to a fresh one; old keys are re-wrapped so you keep your history, with an opt-out for when you're rotating because the old phrase leaked. | live |
| Signed voice fingerprints | In a call, each peer's DTLS fingerprint is signed with their Ed25519 key and checked against their published identity. A mismatch aborts that peer instead of degrading to an unverified call. | live |
| TLS 1.3 | Encrypts the connection between your browser and the server, like every HTTPS site. | live |

A few deliberate choices worth knowing: every primitive above is **native
WebCrypto** — chalk bundles no cryptography library and ships no WASM. The
encryption phrase is the one and only decryption secret, so guard it like a
wallet seed: lose it and lose those messages, leak it and leak them. And two
things are explicit **non-goals**, not oversights: forward secrecy (old
messages staying safe if a key later leaks) and post-quantum resistance. The
full reasoning, threat model, and recovery design live in
[docs/threat-model.md](docs/threat-model.md) and [docs/design/](docs/design/).

## Documentation

- [docs/architecture.md](docs/architecture.md) — system overview
- [docs/wire-protocol.md](docs/wire-protocol.md) — the `chalk.v1` WebSocket protocol
- [docs/threat-model.md](docs/threat-model.md) — current state + planned guarantees
- [docs/browser-support.md](docs/browser-support.md) — supported engines + minimum versions
- [docs/deployment.md](docs/deployment.md) — running it in production with `chalkctl`
- [docs/theming.md](docs/theming.md), [docs/notification-sounds.md](docs/notification-sounds.md) — client customization
- [docs/phase-31/](docs/phase-31/) — the password + TOTP auth design (spec and addenda)
- [docs/design/](docs/design/) — design specs (multi-device, attachments, the phase-30 voice/video plan, crypto agility)
- [docs/phase-log.md](docs/phase-log.md) — the build history (what shipped, when) and roadmap

Release-by-release notes in plain language are in
[CHANGELOG.md](CHANGELOG.md); the phase-by-phase engineering history is in
[docs/phase-log.md](docs/phase-log.md). (This README intentionally doesn't
track phase status — see those instead.)

## License

BSD-3-Clause — see [LICENSE](LICENSE).

chalk's licensing has changed over its life: MIT through the 9.x series,
then GPL-3.0-or-later in phase 11a to align with the (now-removed)
@wireapp/core-crypto dependency, and — with that dependency gone after the
21-series rip-out — back to the permissive BSD-3-Clause. Relicensing was
done by the sole copyright holder; commits remain available under whichever
license was in effect when they were made.

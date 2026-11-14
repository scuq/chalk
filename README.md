<p align="center">
  <img src="web/icons/logo.svg" width="140" alt="chalk logo">
</p>

<h1 align="center">chalk</h1>

A self-hosted, end-to-end-encrypted group chat: one Go binary, Postgres, and a
browser client. Near-black with soft mint text by default (fifteen themes, four
bundled monospace fonts),
Slack-style threading, Discord-style voice/video rooms.

Accounts are password + TOTP; passkeys are an optional convenience on top,
never a bypass of the second factor.

> **Crypto status.** chalk is **end-to-end encrypted**. Messages, edits,
> reactions and attachments are encrypted in the browser under per-channel
> space keys (AES-256-GCM), and the server stores only ciphertext. Every
> message, edit and reaction is also an Ed25519-signed envelope that the client
> checks against pinned identities. The client pins the identity of the server
> it registered with, and it stops at a changed server key. Three limits
> remain:
>
> - chalkd is trusted. Channel membership is server-asserted by design, so a
>   chalkd that lies about the members can be handed a channel key by a
>   member's client.
> - With `CHALK_WRAP_SIG_REQUIRED` off, a server can substitute a channel key
>   on a channel before any current-build member opens it. It is on by default
>   for a new deployment. An older deployment must run `chalkctl wrapsig
>   enable`.
> - Guest messages are unsigned, and the app has no screen to rotate your
>   encryption phrase.
>
> See [docs/threat-model.md](docs/threat-model.md) for what holds today, what
> does not, and the metadata the server sees regardless.

## What's in it

Everything here is built and released. Features that are off by default say so.

- **Messaging**: channels, direct messages, threads with titles and a thread
  inbox, replies, quoting a message, @mentions with autocomplete, typing
  indicators, per-user unread tracking with a new-messages divider that syncs
  across your devices, day marks while you scroll back, and search of the
  messages on your device (Ctrl/Cmd+K) that can walk the full history.
- **Message actions and formatting**: react with emoji and see who reacted,
  edit your own messages within 15 minutes (marked `(edited)`), and delete under
  per-channel rules (your own words are always yours to retract). Also an emoji
  picker, typed emoticons that become emoji, code blocks, compact link labels,
  and link previews for YouTube and Steam that you opt in to. Nano markdown
  (italics, bold, code) is off until you turn it on.
- **Attachments and media**: encrypted uploads with encrypted previews, drag and
  drop, clipboard paste, per-file progress, a tile grid for several pictures, a
  gallery that pages and zooms, and video that shows a poster frame and plays in
  the chat. Giphy is a per-user opt-in. A channel owner can pin a banner image.
  Profile pictures with a crop step are off until you turn them on.
- **Voice and video**: voice channels over a WebRTC mesh with coturn as the
  mandatory relay, camera and screen or game sharing together, adaptive quality,
  background blur, device pickers, microphone modes and push-to-talk keys,
  per-person volume that can go past 100%, call sounds, pop-out windows, and a
  scratchpad. Temporary rooms with guest links are also available. Voice is off
  by default (`CHALK_VOICE_ENABLED`). Guest rooms are off unless the operator
  enables them.
- **Notifications**: notification sounds in selectable themes, per-channel
  notification priority and rules that follow you across devices (encrypted),
  desktop banners, a blinking tab, and an unread count in the tab title. Web
  push is per device. It is off until the administrator runs `chalkctl push
  enable`. A push names the sender and the channel and never shows the message.
- **Privacy and encryption**: end-to-end encryption with signed envelopes,
  pinned identities and key-changed warnings, picture-word verification, a
  pinned server identity with its fingerprint in settings, notices for roster
  changes that your device observes, a channel key that rotates after a member
  leaves, signed voice fingerprints, a backup of your pins, and a parking lot
  (F9) that hides chalk from a passer-by. The caveats are in the crypto status
  box above.
- **Governance and channel types**: text channels, voice channels, and
  temporary voice rooms. Each channel is `dictator` or `democratic`. In
  democratic mode, membership changes, deletions and mode changes run as
  proposals that the members vote on. A democratic channel cannot be renamed.
  The owner of a channel can rename it and give it a short name.
- **Accounts and identity**: password and mandatory TOTP, optional passkeys, two
  separate 24-word phrases (one resets your login, one is your encryption
  identity), multi-device onboarding with the encryption phrase, a security
  panel (change password, reset TOTP, passkeys), sessions that end 90 days after
  sign-in, and an in-app admin panel for block, unblock, soft-delete, purge, and
  an email blacklist.
- **Roster and organisation**: a friends list with a directory and one-click
  add, hover cards, online and away status, channel groups and a roster filter,
  an order by creation, by activity or by hand (drag and drop on a desktop),
  hidden channels, and chaos mode (one list of text channels, newest first),
  which is on by default on a desktop.
- **Phone layout**: the conversation list is the phone layout, with friend
  chips, a filter bar, icon buttons for the parking lot, threads, filter, add a
  friend and new channel, a full-width message box, grouped messages, a slide
  between the list and a chat, and a swipe back. In a call, the phone has a call
  bar, a call view with a camera flip button, and a screen wake lock. A long
  press on a row opens a sheet. Some checks on a real phone are still open (see
  [docs/open-items.md](docs/open-items.md)).
- **Desktop app**: an Electron app for Windows, macOS and Linux with a tray,
  close to tray, a system default browser for links, OS-level away detection,
  and signed self-update. See [Desktop app](#desktop-app).
- **Look and feel**: fifteen themes (five light, ten dark), four bundled
  monospace fonts with sans and serif, text-size steps, a full-window width,
  a resizable sidebar and message box, hidden scrollbars as an option, per-user
  nick colours, an installable PWA, a version badge, and a what's-new note after
  an update. Flair (animated frames, flame and wave) is off by default. A
  seasonal scene in the top bar has a switch per device and a server switch.
- **Operations**: `chalkctl` deploys, updates, backs up, restores and migrates a
  whole host from cosign-verified container images, with a weekly update timer
  and Caddy for TLS. It also gives a maintenance page, `chalkctl metrics` for
  Postgres, `chalkctl push`, `chalkctl wrapsig`, `chalkctl ephemeral`, and
  `chalkctl serverkey show`. The server can log sign-in events, slow requests,
  a connected-user snapshot, and a web access log.

## Screenshots

The default dark theme (fourteen more in settings) and the light theme, on a
dev instance. The two shots show the same conversation.

### Desktop

![A channel in the dark default theme. The sidebar lists a friend, the Parking Lot, threads and two channels. The conversation shows reactions, an @mention and a thread indicator with two replies](docs/screenshots/chat-desktop.png)

![The same channel in the light theme: a cream page with dark green text, and the same sidebar, messages and reactions](docs/screenshots/chat-desktop-light.png)

![The dark theme with the thread panel open on the right, showing the first message of the thread, two replies and the reply box](docs/screenshots/chat-thread.png)

### Voice and video

A voice room with two cameras on, in the dark and the light theme. The video is
a test pattern from Chromium's built-in fake camera, because the browser that
took the shots has no real camera.

![A voice room in the dark theme. Two camera tiles show a test pattern (a green screen with a counter and a pie shape) above the room scratchpad. A column at the left holds the call timer and the mute, deafen, camera, share, settings and leave buttons](docs/screenshots/voice-desktop.png)

![The same voice room in the light theme, with the same two test-pattern camera tiles](docs/screenshots/voice-desktop-light.png)

### Phone

The conversation list, a conversation, and the call view.

<p>
<img src="docs/screenshots/chat-mobile-list.png" width="250" alt="The phone conversation list: five icon buttons, two friend chips, an unread channel, an unread direct conversation, and a read channel">
<img src="docs/screenshots/chat-mobile.png" width="250" alt="A phone conversation. A channel shows a reaction. The message box has a full-width field above a row of tools and the send button">
<img src="docs/screenshots/voice-mobile.png" width="250" alt="The phone call view. The other person fills the screen as a test pattern, and your own camera is a small tile in the corner. The controls are muted, deafen, camera, share and leave">
</p>

## Quick start (development)

Requirements: Go 1.27+, Node 22+, Docker 24+, Bash 5.2+, `make`, `git`.

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
chalkctl up        # start the stack; `down` stops it
chalkctl backup    # encrypted archive of the database + env + config
chalkctl restore   # load such an archive into an initialized host
chalkctl maint     # on|off|status — serve a notice instead of the app
chalkctl metrics   # what postgres knows about its own performance
chalkctl images    # version/revision/created for each image in the stack
chalkctl reconfigure-turn   # re-render + restart coturn only
```

It renders podman Quadlet units for chalkd, Postgres and coturn, sets up Caddy
for TLS, verifies GHCR pulls with cosign, and installs a weekly update timer.
See [docs/deployment.md](docs/deployment.md).

### Backups

```sh
chalkctl backup --out /root/chalk.chalkbak
```

One password-encrypted file (Argon2id + AES-256-GCM) holding the database —
every message, channel, membership, device and attachment, since attachment
ciphertext is a database column rather than a file — plus `chalk.env` and
`chalkctl.conf`. The env file matters as much as the dump: `CHALK_TOTP_ENC_KEY`
is what the stored TOTP secrets are encrypted under, and a database restored
without it locks every account out at the second factor.

The password comes from `--password-file`, `$CHALK_BACKUP_PASSWORD` or a
prompt, and there is no recovery path if it is lost. Nobody is interrupted
while a backup runs: `pg_dump` reads a consistent snapshot. Every Postgres
command runs inside the container, so the host needs no `psql`.

### Moving to a new host

```sh
# old host
chalkctl maint on --message "moving to a new server, back by 14:00 UTC"
chalkctl backup --out /root/chalk.chalkbak
scp /root/chalk.chalkbak newhost:/root/

# new host — a normal fresh init first, so Caddy issues real certificates
# and the stack is proven healthy before any data is at stake
chalkctl init --domain chat.example.org --rootful \
    --admin-username <name> --admin-email <addr>
chalkctl restore /root/chalk.chalkbak
chalkctl maint off
```

`restore` requires an initialized host and never touches the units, the
Caddyfile or the image pin. It replaces exactly two things: the contents of the
database, and `CHALK_TOTP_ENC_KEY` in the env file. Everything else `init`
generated stays, because it belongs to the host actually serving — its Postgres
password, its TURN secret, its WebAuthn RP ID.

It streams the archive in one pass, showing the source domain, version and
backup date and asking you to confirm before anything is written, and the load
runs as a single transaction: a restore either lands completely or leaves the
database as it was.

**Keep the domain the same** if you can. Passkeys are bound to it, so a rename
invalidates them — everyone can still sign in with password + TOTP and enrol a
new passkey. Sessions, identities and message history survive either way. If
the domain does change, point DNS at the new host before `init`, or Caddy
cannot issue a certificate.

### Metrics

```sh
chalkctl metrics              # sizes, cache hit ratio, growth, bloat, bad plans
chalkctl metrics --sample 30s # two readings, reported as rates
```

Reads only Postgres' in-memory statistics views, so it costs no table I/O and
is safe on a busy host — no `count(*)`, no `pgstattuple`, no summing attachment
bytes. Row counts are planner estimates and attachment volume comes from
partition sizes, which is also why growth-per-month is free: `messages` and
`attachments` are partitioned monthly, so the partition sizes *are* the curve.

It surfaces the things that explain a slow server: cache hit ratio, anything
sitting idle-in-transaction (which blocks autovacuum database-wide), tables
being read start-to-finish, dead rows autovacuum has not reclaimed, indexes
never read, and checkpoints forced by WAL volume. Per-query timings are opt-in
via `chalkctl init --force --pg-stat-statements`, since collecting them costs a
little on every statement.

### Maintenance mode

```sh
chalkctl maint on --message "back by 14:00 UTC"
chalkctl maint off
```

Re-renders only the Caddyfile so Caddy answers every request itself with a 503
notice, then reloads it in place. Caddy stays up, so the certificate keeps
renewing while the app is down — without this, stopping chalkd leaves everyone
on a bare 502. `/healthz` still reaches chalkd, so `update` and `restore` can
tell a healthy app from a hidden one, and `init --force` preserves the mode
rather than putting the site back in front of users mid-repair.

## Desktop app

chalk also ships as a desktop app for **Windows, macOS and Linux** (phase
104, record in [docs/phases/PHASE-104-DESKTOP.md](docs/phases/PHASE-104-DESKTOP.md)).
It is an Electron shell around your server's own page — nothing of chalk is
bundled into it, so it is always exactly as current as the server it opens —
plus the things a browser tab cannot do:

- **links open in your system default browser**, whatever the app is built on;
- **close to tray**: closing the window keeps chalk connected, notifications
  keep arriving, the tray icon brings it back; *Quit* is in the tray and the menu;
- **away detection that sees the whole desktop** (how long since you touched
  the machine, and the screen lock on Windows and macOS), with no browser
  permission prompt;
- calls, screen sharing (its own picker), passkeys, notifications and the
  output-device picker work as in Chrome, because it *is* Chromium.

**Download.** Every release carries `chalk-desktop-<version>-<os>-<arch>`
archives — `windows-x64`/`windows-arm64` (zip), `macos-arm64`/`macos-x64`
(zip with `chalk.app`), `linux-x64`/`linux-arm64` (tar.gz) — next to
`SHA256SUMS.desktop`, which is cosign keyless-signed like the other assets.
Unpack anywhere and run `chalk`; it asks for your server the first time
(`https://…` only — the session cookie is `Secure`), remembers it, and
`Ctrl/Cmd+Shift+S` switches. `chalk --server https://chat.example.org` skips
the picker.

- **Windows** warns about an unknown publisher: the exe is signed with
  chalk's own self-signed certificate (`chalk-codesign.cer` is in the zip;
  import it into *Trusted Publishers* to silence SmartScreen). Toasts are
  attributed to "chalk" only after an installer exists; until then they say
  Electron.
- **macOS** is not notarized (no Apple developer account): the first launch
  needs right-click → *Open*. Passkeys need a native module the shell does
  not have yet; password + TOTP works.
- **Linux** needs a tray host for the icon (KDE, XFCE, MATE have one; GNOME
  needs an AppIndicator extension — without it the window still hides on
  close and comes back by launching `chalk` again). `chalk
  --install-desktop-entry` writes a launcher entry and icon under
  `~/.local/share` pointing at wherever you unpacked it.

**Updates.** The app checks GitHub once a day. On Windows and Linux a newer
release is downloaded in the background, verified against chalk's release
key (an Ed25519 signature over the release's checksums — nothing unsigned is
ever installed) and unpacked *beside* the running version; a dialog, the tray
and the *chalk* menu then offer **Restart to update**, which starts the new
version and drops the old one on its next start. Your unpacked copy is never
modified; the new version lands next to it (or under the app's data directory
if that place is read-only). On macOS the new `chalk.app` replaces the old
one at the same path, so a Dock pin keeps working. Wherever verification is
not possible, the app only tells you and links to the release page.
The version you came from is kept, and *Roll back to the previous version…*
in the *chalk* menu takes you back (that release is then never offered
again; the next one is). *Check for updates…* is in the menu and the tray.
Both switches — close-to-tray and the daily check — are on the server picker
page (`Ctrl/Cmd+Shift+S`) under *Preferences*, or in `desktop.json` under the
app's config directory (`chalk-desktop/`).

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
- [docs/phases/PHASE-31-AUTHV2.md](docs/phases/PHASE-31-AUTHV2.md) — the password + TOTP auth design, as built
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

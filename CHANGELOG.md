# Changelog

What changed in chalk, in plain language — newest first. Version numbers are
the release tags: one `vX.Y.Z` tag builds both the container image and the
matching `chalkctl` binary. Day-of releases are grouped by theme rather than
listed one patch version at a time.

The engineering-level history (which slice shipped what) lives in
[docs/phase-log.md](docs/phase-log.md).

---

## Unreleased

### Fixed
- **The voice connection panel no longer spills over the message list.** With a
  narrow sidebar, the mute, deafen and leave buttons at the bottom left ran off
  the edge of the column and sat on top of the conversation. They now shrink to
  single letters — `m`, `d`, `l`, still colour-coded and with the full wording
  on hover — and grow back to words once the sidebar is wide enough to hold
  them.

---

## v0.3.42 — 26 July 2026 — Composer, emoticons and message actions

### Added
- **Typed emoticons become emoji.** Type `:)` and you get 😀, the way chat
  clients did it before the web — along with `;)`, `:D`, `:P`, `:(`, `<3`,
  `8-)` and a couple of dozen more. It only fires on an emoticon typed on its
  own, so pasted links and "see step 8)" are left alone, and backspace right
  after a swap puts the characters back when you meant the punctuation. Turn it
  off under chat settings in your profile.
- **Keyboard shortcuts for the composer buttons.** `ctrl+e` opens the emoji
  picker, `ctrl+g` the GIF picker, and `ctrl+shift+f` the file dialog (`⌘` on a
  Mac). The new `?` button next to them lists every composer key, including the
  ones nobody finds on their own: shift+enter for a new line, cursor-up to edit
  your last message.
- **Links in messages are clickable.** Paste an address starting with `http://`
  or `https://` and it becomes a link that opens in your browser, in a new tab
  — or in your default browser if you run chalk as an installed app or in a
  pop-out window. A full stop or a closing bracket at the end of the sentence
  stays out of the link, and a bracket that belongs to the address keeps it.
  Only web addresses are ever linked; anything else stays as plain text.
- **Network controls in the call's debug panel.** The debug button in a voice
  call now has three switches for how your connection is routed: *relay only*
  sends everything through the server's relay instead of straight to the other
  people — it hides your address from them and gets through networks that block
  direct connections; *ipv4 only* ignores IPv6 paths, for a machine whose IPv6
  looks available but never connects; *no lan* keeps a call off the local
  network shortcut. The panel shows which routing is actually in force,
  including when the server requires the relay for everyone, and a *rejoin*
  button applies a routing change to the room you are already in. The settings
  stay on that device and travel into the copied diagnostics report.

### Changed
- **Everything you can do to a message is now in one menu.** Right-click a
  message — or click the small `⋮` that appears in the left margin when you
  hover a line, or press and hold on a phone — and you get a row of one-click
  reactions, the full emoji picker, reply in thread, copy the text, and edit or
  delete where those are yours to do. The strip of buttons that used to float
  over the right-hand end of a message is gone. Hovering a message and pressing
  `r` opens the same menu. Right-clicking a link, an image or text you have
  selected still gives you the browser's own menu.
- **The composer got out of its own way.** The message box now sits directly
  under the messages, with the file, GIF and emoji buttons moved down beside it
  into the roster's column instead of stacked above the field. Send is a small
  button parked at the bottom corner rather than a full-height slab — enter
  still sends. On a phone the buttons sit under the box instead.
- **Editing a message looks like editing a message.** Pressing cursor-up to fix
  your last line now frames the whole box in the accent colour and turns the
  button into a matching "save", so an edit you started by accident is obvious
  before you hit enter.
- **Calls use IPv6 again.** Every call quietly dropped IPv6 paths to work
  around one machine with a broken IPv6 interface, which penalised everyone on
  a working IPv6 network. Calls now use whatever paths your network offers, and
  the workaround is the *ipv4 only* switch in the call debug panel for anyone
  who still needs it.

### Fixed
- **Message actions no longer sit on top of the message.** The old hover
  buttons covered the end of the first line of anything long enough to reach
  them, and the "more" menu was cut off by the bottom edge of the conversation
  when you opened it on the last message in a channel. The new menu opens where
  your pointer is and moves itself to stay on screen.

---

## v0.3.41 — 26 July 2026 — Microphone settings

### Added
- **Microphone settings.** There's a microphone section in your profile now.
  Pick which mic to use when you have more than one, set the input volume by
  hand when yours is too quiet or too hot, and switch echo cancellation, noise
  suppression and automatic gain control on or off. Press test to watch a level
  meter while you talk — drag the volume until you're filling most of the bar
  without turning it red. Everything applies to a call you're already in, so
  you can fix a mic mid-conversation without leaving and rejoining, and the
  settings stay on the device rather than following you between machines.
- **Choose when your mic transmits.** Four options, in the same place: always
  on (what chalk did until now, and still the default), open when you speak,
  push to talk, or push to mute. "When I speak" gives you two marks you drag
  onto the level meter — one for where your voice sits, one for where the room
  sits — so a pause mid-sentence doesn't cut you off, plus a setting for how
  long to keep sending after you stop so your last syllable survives. A dot
  next to the mute button shows when you're actually being heard.
- **Keys for talking, muting and deafening.** Bind your own: hold-to-talk (or
  hold-to-mute), a mute toggle, and deafen, which silences everyone at once and
  mutes you along with them. Unmuting brings your ears back too. Note that keys
  only reach chalk while a chalk tab is the window in front — a web page can't
  claim a key from the rest of your system, so push to talk won't work from
  inside a fullscreen game.

---

## v0.3.40 — 26 July 2026 — Notification sounds

### Added
- **chalk makes a sound now.** A message, a mention, a DM, a reply in one of
  your threads — each one is a short stroke of chalk on a board, pitched so you
  can tell them apart without looking. It stays quiet for the channel you're
  already reading, never fires more than once every couple of seconds, and can't
  make a noise at all until you've clicked something, so a tab left open
  overnight stays silent. Under notifications in your profile you can set the
  volume, choose what makes a sound, hear each one before you decide, and switch
  on do-not-disturb. There are sounds for your own connection dropping, a friend
  coming online and send confirmations too, switched off to begin with. The
  settings stay on the device instead of following you around, so your phone and
  your desktop can disagree.

---

## v0.3.29 — 26 July 2026 — Two new themes

### Added
- **New "warmwhite" theme.** A dark graphite channel rail beside a warm
  near-white page, with black titles and a blue accent on links and controls.
  Pick it under appearance in your profile.
- **New "azeroth" theme.** Quest gold and bronze frames on a tavern-dark
  ground, with the rest of the palette borrowed from where those colors come
  from: green for online, orange for warnings, blue for links.

---

## v0.3.28 — 25 July 2026 — Version badge and the blade-runner theme

### Added
- **New "blade-runner" theme.** Neon scarlet on a smoky black city ground,
  with teal links and a soft red glow on emphasis. Pick it under appearance in
  your profile; like every theme, it follows you across devices.
- **The version you're running is shown in the app.** It sits next to the
  chalk wordmark in the header, and under "about" in your profile; clicking it
  opens the changelog for that exact build. Development builds read "dev" and
  link to the latest changelog instead.
- **React without opening a menu.** A react button sits in the row actions,
  and pressing `r` while hovering a message opens the picker.

### Fixed
- **Being added to a channel works without a reload.** Two problems, both
  gone: members showed up as UUID fragments (sender names, roster and mention
  highlighting) until the next reconnect, and a channel could sit on "waiting
  for key" forever if you asked for your key a moment before the inviter
  deposited it. The server now sends handles with the channel, and the client
  retries the key as soon as it lands.

---

## v0.3.27 — 25 July 2026 — Edit and react

### Added
- **Emoji reactions.** React to any message; chips with a tally appear under
  it, and reactions on older messages are fetched as you scroll back.
  Reactions are end-to-end encrypted like everything else, per user.
- **Edit your own messages.** Press cursor-up to edit the last one you sent,
  or use the row menu. Edited messages are marked `(edited)`. The window is
  15 minutes from when the message was sent, and only the author can edit —
  there is deliberately no owner override and no vote: deleting is a
  moderation action a channel can have opinions about, putting words in
  someone's mouth is not. A deleted message can't be edited back into
  existence.

---

## v0.3.20 – v0.3.26 — 25 July 2026 — Mobile, unread tracking, deletion, PWA

### Added
- **Mobile layout.** A roster drawer, stacked message rows, safe-area insets
  for notched screens, and compact row actions that fit a narrow screen.
- **Unread tracking.** Per-channel read cursors that sync across your
  devices, unread and mention dots in the sidebar, a "new messages" divider
  in the feed, and landing on the first unread message when you open a
  channel. Mentions are detected client-side, so the server never needs your
  plaintext.
- **Message deletion, with rules.** Your own messages are always yours to
  delete, in any channel. Someone else's follows the channel's governance
  mode: the owner deletes unilaterally in dictator mode (confirmed twice,
  since it erases another member's words), and in democratic mode any member
  can open a proposal the channel votes on. The same rules apply in threads.
- **Reading comfort.** Resizable sidebar with a remembered width, per-device
  font family and text size (Hack is bundled, no network fetch), and an LCARS
  theme.
- **Installable app.** chalk logo in the header, app icons and a web manifest,
  so it installs as a PWA; the pop-out window now recognises itself reliably
  and hides its own pop-out button.

### Fixed
- **You no longer appear offline while you're online.** A closing tab could
  delete the presence row a newer connection had just claimed, presence
  counted devices instead of connections (so a second tab closing took you
  offline), and after another instance reclaimed a dead one, nothing
  re-asserted presence for the connections still open. All three fixed;
  hiding a tab now debounces before marking you away.
- **The view stops jumping** while images finish loading when you land in a
  channel.
- Full-width attachments keep the right-hand gutter instead of running to the
  window edge.
- The hover reply button shows in compact mode (delete already did).
- Modal dialogs have a real surface and readable contrast in every theme.

---

## v0.3.15 – v0.3.19 — 25 July 2026 — Passwords and two-factor (auth v2)

**Heads-up: this changes how everyone logs in.** Existing accounts are walked
through a migration wizard on their next sign-in.

### Changed
- **Sign in with a password and a 6-digit code.** Signup asks for a handle, a
  password (at least 20 characters across 4 character classes), a TOTP QR code
  to scan, and then shows you your two 24-word phrases. The password never
  leaves your browser — it's stretched with Argon2id and the server only sees
  a derived proof.
- **Two separate phrases, with separate jobs.** The *recovery phrase* gets you
  back into the account; the *encryption phrase* is your cryptographic
  identity and never leaves the client. Losing one does not cost you the
  other.
- **Passkeys are a convenience, not a bypass.** They still work, and they
  still ask for your TOTP code. Two-factor is mandatory on every path.
- **Recovery resets your login instead of performing it.** The old behaviour
  signed you in from the phrase alone: that skipped the second factor
  entirely and left you logged in but unable to change the password you'd
  forgotten. Now the phrase plus a live TOTP code sets a new password — or,
  if the authenticator is what you lost, clears TOTP so you can re-enrol
  through the session it mints.
- **Claiming the admin account** now uses a one-shot bootstrap token URL
  (`/?admin_token=…`, printed by `chalkctl init`), which stops working the
  moment the admin account has credentials. The old passkey-based bootstrap
  is gone.

### Added
- **Security panel** in your profile: change password, reset TOTP, relink the
  encryption phrase.

### Fixed
- **Passkeys synced across devices could refuse to log in** with a "Backup
  Eligible flag inconsistency" error, because the credential's backup flags
  weren't stored when it was registered. They're persisted and restored now.

---

## v0.3.0 – v0.3.14 — 22–23 July 2026 — Composer, message layout, duplicate messages

### Added
- **Emoji picker in the composer** — about 350 emoji in 8 categories with
  keyword search, so "lol" finds 😂 and "+1" finds 👍. Picks land at the
  caret (or replace the selection) instead of being appended, and the picker
  stays open for several picks.
- **Per-user nick colours**, stored as a hue so they stay readable when you
  switch themes. Everyone is auto-coloured from their handle; right-click or
  long-press a friend in the roster to pick or reset theirs.
- **Two themes:** snazzy-light (cool near-white, magenta accent) and
  tokyo-night.
- **Composer tool row** above the input — file, GIF, emoji — as text labels or
  icons, your choice. It no longer eats the width of the input field.
- **Pop-out button** that opens chalk in its own right-sized window.

### Fixed
- **Messages no longer appear twice.** Your own send could show up as both the
  local copy and the server's copy after a reconnect or a channel switch.
  Every send is now acknowledged to the sender with the stored message, so the
  local copy is retired exactly once no matter which path delivers the real
  one.
- **No more accidental second DM.** The new-channel dialog's "direct message
  (1:1)" checkbox could create a *second* DM with someone you already had one
  with — the new one starts empty, so the old conversation reads as "my
  messages are gone". The checkbox is gone, and asking for a DM that already
  exists returns the existing one.
- **Deploys take effect on the next page load.** Bundle filenames are
  content-hashed and cached immutably, so no more hard refresh after an
  update.
- Governance controls are hidden in DMs, where a vote between two people means
  nothing.
- **Message rows line up.** Timestamps align with the first line of a
  multi-line message instead of its middle; GIFs and attachments start at the
  body column instead of the row edge; the reply indicator and preview sit
  with the message they belong to; compact mode uses one font size throughout;
  the sender column is sized to the widest name in view (long names wrap), and
  shows your own handle rather than "you".

---

## v0.2.0 – v0.2.3 (plus ctl-v0.2.1 … ctl-v0.7.2) — 21–22 July 2026 — Deployment manager and voice fixes

### Added
- **`chalkctl` grew into a full deployment manager**: `init` seeds the admin
  identity and WebAuthn config so the deployment is loginable out of the box
  (with flags for the voice/attachment/Giphy knobs, plus `--force` and
  `--drop-db`), `up` / `down` / `status` for lifecycle, `images` to show what
  provenance the running image carries, `update` to verify, swap,
  health-check and roll back automatically, and `reconfigure-turn`. coturn
  runs on alpine, the external IPv4 address is detected automatically, and
  `-n` logs to stdout.
- **Images carry OCI provenance labels** (version, revision, build date), so
  `podman inspect` tells you exactly which commit is deployed.

### Fixed
- **Video stopped flickering** roughly once a second in calls — the video
  element was being torn down and rebuilt on every re-render instead of
  being reused.
- **Calls work on hosts with a VM or VPN bridge.** Non-routable IPv6 ULA
  candidates were being offered and failing TURN lookup; ICE now filters to
  IPv4.
- **Deployments come up on PostgreSQL 18**, which moved its data directory
  into a versioned subdirectory.
- **chalkd starts with the configuration it was given.** Quadlet expands
  `Environment=` before the env file is loaded, so any setting composed from
  another one collapsed to empty and the server failed to start; composed
  values are now written out literally, and secrets no longer round-trip
  through unit files at all (coturn reads its own config file).

---

## v0.1.0 — 20 July 2026 — First tagged release

- **Signed releases.** Multi-arch container image and `chalkctl` binaries,
  built by CI and cosign-signed, published to GHCR. `chalkctl` verifies the
  signature before it pulls.
- **Self-installing deployment.** `chalkctl init` renders podman Quadlet units
  and brings up chalkd, Postgres and coturn on a fresh host.
- **Voice and video complete** through screen/game sharing and adaptive
  quality (see below).

---

## Before v0.1.0 — the untagged build (phases 00–30)

The condensed story. The full slice-by-slice record is in
[docs/phase-log.md](docs/phase-log.md).

- **End-to-end encryption (phases 22–25).** Your identity keys come from a
  24-word phrase; each channel has a shared key that encrypts its messages,
  and that key is handed to each member wrapped under their public key. The
  server went back to being a blind relay. Includes picture-word verification
  against key substitution, and key rotation when someone is removed —
  they can't read anything sent afterwards.
- **Voice and video (phase 30).** Discord-style voice channels: a WebRTC mesh
  with coturn as the mandatory relay, signalling encrypted under the channel
  key, and each peer's call fingerprint signed by their identity (a mismatch
  aborts the call rather than continuing unverified). Sidebar occupancy with
  mute/camera/screen badges, a big-tile + filmstrip stage, call duration, and
  a diagnostics drawer. Screen and game sharing with a motion / detail / text
  quality preference, shared program audio, and camera plus screen at the
  same time. Adaptive quality measures your uplink before the call, keeps
  watching passively during it, and divides the budget across peers instead
  of overshooting. Off unless `CHALK_VOICE_ENABLED` is set.
- **Attachments.** Encrypted uploads with encrypted previews and metadata (the
  server sees only sizes), drag-and-drop and clipboard paste with per-file
  progress, and a local ciphertext cache. Giphy is opt-in per user and proxied
  through the server against a host allowlist.
- **Governance.** Each channel is `dictator` or `democratic`. In democratic
  mode, removing or adding a member, deleting a message, or changing the mode
  runs as a proposal the members vote on, with a frozen eligibility snapshot,
  quorum, cooldowns and expiry.
- **Multi-device.** A second device re-enters your encryption phrase, derives
  the same identity and checks it against the published one before saving it,
  so you can't accidentally fork your identity. Your messages echo to your
  other devices.
- **Admin moderation.** Block, unblock, soft-delete and purge users, plus an
  email blacklist, from an in-app admin panel.
- **License: GPL-3.0-or-later → BSD-3-Clause.** chalk moved to GPL only to
  match the `@wireapp/core-crypto` dependency; that dependency and all
  MLS/WASM code were removed in the 21-series rewrite, so the project returned
  to a permissive license. Done by the sole copyright holder; pre-relicense
  commits remain under their original terms (MIT through 9.x, GPL-3.0 during
  11a–21).

---

## Planned

- A server-side mixer (SFU) for voice rooms too large for a mesh.
- Governing per-channel settings by vote (`set_config` proposals).

---

## Phase numbering note

Phase numbers in the commit log and [docs/phase-log.md](docs/phase-log.md)
differ from the original `bootstrap/` scaffold's stub names. The canonical
mapping: **09** auth (shipped as 09a–09d); **10** skipped (the original "MLS"
phase folded into the 11-series); **11a** CoreCrypto foundation and **11b** MLS
DMs (both later removed in the 21-series rip-out); **21** MLS removal; **22–25**
the encryption rebuild that replaced it; **30** voice/video; **31** password +
TOTP auth; **32–38** the client polish arc (mobile, unread tracking, presence,
deletion, branding, edits and reactions).

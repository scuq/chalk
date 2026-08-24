# Phase 105 — one-click self-update for the desktop app

**Status:** 105-1 (signed sums, the verifier) built 2026-08-25; 105-2 … 105-5
designed below, not started. **The release key is not made yet** — until
scuq runs `tools/make-release-key.sh`, pins the hex in
`desktop/src/selfupdate/key.ts` and sets `RELEASE_SIGN_KEY_B64`, the
verifier refuses everything by design and nothing changes for users.

**Tag:** `#selfupdate` → `tools/where.sh -g selfupdate` (`desktop/src/selfupdate/`,
`tools/make-release-key.sh`, the signing step in `.github/workflows/release.yml`).

## The problem

Phase 104-4 tells a desktop user that a newer release exists and links to
it. Installing it is: download a zip, unpack over the old directory, restart.
Discord's answer — update in the background, "restart to update" — is the
bar, and scuq asked for it. The trap is *how* Discord does it: Squirrel's
`Update.exe` owns the install and is what shortcuts point at. That helper is
the part chalk does not need; the layout is the part it does.

## The design

**Side-by-side, never in place.** The running version is never overwritten
and never killed. A newer release is downloaded and unpacked *beside* it;
"restart to update" launches the new one and quits the old; the old
directory is removed on the next successful start. Atomic switch, free
rollback, no "file in use" races, no second executable to ship.

```
<install root>/
  app-0.9.0/  chalk.exe …      running
  app-0.9.1/  chalk.exe …      unpacked, verified, .ready marker
  desktop.json is NOT here (it lives in userData; the install root is code only)
```

- **Windows.** Install root = the parent of the running directory when it
  is writable (the user unpacked the zip somewhere of their own), else
  `%LocalAppData%\chalk\`. After unpacking, `shell.writeShortcutLink`
  retargets the Start-menu shortcut (created on first run if absent, with
  the `org.chalk.desktop` AppUserModelID so toasts finally say "chalk"),
  then `spawn(newExe, {detached})` + `app.quit()`.
- **macOS.** Unpack `chalk.app` next to the running bundle as
  `chalk.app.next`, on restart rename running → `.old`, `.next` → `chalk.app`,
  `open` it. Works because the app is ad-hoc signed (no notarization); the
  downloaded bytes never get a quarantine attribute because Node's https
  wrote them, not a browser. **If the app is ever notarized, updates must be
  signed with the same identity** — that is the day this design changes.
- **Linux.** Same as Windows without the shortcut; `--install-desktop-entry`
  is re-run for the new path. AppImage later, if ever.

**Trust — the part that matters.** The updater is the highest-privilege
channel in the app. It verifies before it touches a byte:

1. The release workflow signs `SHA256SUMS.desktop` with a **release Ed25519
   key** (private half a GitHub Actions secret, public half pinned in the
   shell). cosign keyless stays for humans; the app verifies Ed25519 with
   WebCrypto in the main process — no dependency, the same primitive the
   client already trusts for everything else.
2. The archive's SHA-256 must match the signed sums, the version in the sums
   must be the one announced, and the announced version must be newer.
3. Any failure degrades to 104-4's behaviour — "update available, download
   manually" — never to a silent install, never to a retry with weaker
   checks.

Recorded in `docs/threat-model.md` when built: the desktop trusts scuq's
release key; compromise of that key (or of the CI secret) is compromise of
every desktop that updates. Same posture as `CHALK_WRAP_SIG_REQUIRED`.

**Rejected.**

- *Electron's built-in `autoUpdater` (Squirrel).* Windows-only for chalk —
  macOS requires Developer-ID signing and notarization, Linux is not
  supported — and it replaces the zip with an installer plus Squirrel's
  .NET tooling in CI. Two of three platforms would still be hand-rolled.
- *A `chalk-update.exe` that kills and overwrites.* Fragile where
  side-by-side is atomic; one more binary to build, sign and keep in step.
- *Trusting GitHub alone.* Anyone with release write access could ship a
  binary to every desktop. The pinned key is what makes that a signed act
  by scuq rather than an artifact upload.

## Slices

- **105-1 — signed sums.** Built. `tools/make-release-key.sh` makes an
  Ed25519 key with OpenSSL and prints the raw public key hex to pin in
  `desktop/src/selfupdate/key.ts`; the release job signs
  `SHA256SUMS.desktop` with `openssl pkeyutl -rawin` from the
  `RELEASE_SIGN_KEY_B64` secret (raw 64-byte signature as
  `SHA256SUMS.desktop.ed25519`, plus a `.next` twin from
  `RELEASE_SIGN_KEY_B64_NEXT` during a rotation), skipped when the secret is
  absent. `desktop/src/selfupdate/verify.ts` is the fail-closed chain —
  `verifySums` (WebCrypto Ed25519 over the file's exact bytes; no pinned key
  = refused), `expectedArchive` (the release naming), `verifyArchive`
  (SHA-256 of the download against the verified table) — tested against a
  throwaway key including wrong key, short signature, tampered file, signed
  garbage, one flipped byte.
- **105-2 — Windows.** Download to a temp file, verify, unpack beside the
  running dir, `.ready`, shortcut retarget, "Restart to update" in the
  dialog/tray/menu (replacing 104-4's "Download"), old-dir cleanup on start.
  Rollback = delete the newest dir and relaunch the previous.
- **105-3 — macOS** bundle swap. **105-4 — Linux** dir swap.
- **105-5 — settings**: "check now", opt out (already `checkUpdates`), and
  a "downloaded, restart when convenient" state that survives close-to-tray.

## Manual checklist (when built)

- [ ] a tampered archive (one flipped byte) is refused and the notice falls
      back to "download manually"
- [ ] a sums file signed with the wrong key is refused
- [ ] update → restart → the new version runs, the old directory is gone
      after the second start, `desktop.json` and the identity are intact
- [ ] update while hidden to the tray; the restart prompt waits for the user

# Phase 105 — one-click self-update for the desktop app

**Status:** 105-1 (signed sums, the verifier), 105-2 (the updater core and
the Windows hand-over), 105-4 (Linux) and 105-3 (macOS bundle swap) built
2026-08-25. Linux is what the probe exercises live; the Windows shortcut
retarget and the macOS swap are tested at the layout level (an injected
extractor stands in for `ditto`) and by hand on nobody's Mac yet. 105-5
(settings, rollback entry) designed below, not started. **The release key is not made yet** — until
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

Recorded in `docs/threat-model.md` (105-2): the desktop trusts scuq's
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
- **105-2 — the core, and Windows.** Built. `desktop/src/selfupdate/updater.ts`
  (no Electron in it): `installRoot` (the running dir's parent when writable,
  else `userData/versions`), signed sums → archive hash → unpack with the
  OS's `tar` (Windows 10+ ships `tar.exe`, which reads zips; no zip/tar
  parser of our own) into `chalk-<ver>.partial`, hoist a lone top directory,
  check the exe exists, rename, write `.ready`; `cleanupOldVersions` at the
  next start from the new version. `apply.ts` is the Electron half:
  retarget the Start-menu (and Desktop, if present) `chalk.lnk` with
  `shell.writeShortcutLink` carrying the AppUserModelID, release the
  single-instance lock, spawn the new exe detached, quit. `main.ts`: a newer
  release now *prepares* in the background where a key is pinned and the
  platform swap exists; the dialog becomes "ready to install — Restart now /
  Later", the tray and menu entry "Restart to update to X"; any failure
  degrades to 104-4's "Download" with the reason. Tested end to end against
  a fake release (real tar.gz, real signature from a throwaway key, a fetch
  stub) in `updater.test.ts`, and live in the probe with a packaged Linux
  build and a local fake release server behind the `--insecure`-gated
  `--update-api/--update-base/--update-key` flags. Rollback (delete the
  newest dir, relaunch the previous) is a manual step for now; 105-5 gives
  it a menu entry.
- **105-3 — macOS** bundle swap. Built. `bundleOf`/`runningDir` treat the
  `.app` as the running version; `prepareUpdate` unpacks with `ditto -x -k`
  into `chalk.app.partial`, drops a `__MACOSX` sidecar, moves the bundle to
  `<root>/chalk.app.next` and writes `<root>/.chalk-next` (the marker stays
  outside the bundle: a file added inside would break its code seal);
  `activateMacBundle` renames running → `chalk.app.old`, `.next` →
  `chalk.app` (undoing the first rename if the second fails), and `apply.ts`
  then `open -n`s the new bundle. The Dock pin survives because the path
  does. `cleanupOldVersions` removes `chalk.app.old` and a prepared bundle
  the running version has caught up with. The release job now ad-hoc
  `codesign`s the bundle before zipping so what ships and what the updater
  swaps in carry the same (identity-less) seal; **if the app is ever
  notarized, updates must be signed with that identity too** — the seal
  check would otherwise refuse the swapped bundle.
- **105-4 — Linux** dir swap. Built with 105-2 (same code; `--install-desktop-entry`
  is re-run for the new path when an entry exists).
- **105-5 — settings**: "check now", opt out (already `checkUpdates`), and
  a "downloaded, restart when convenient" state that survives close-to-tray.

## Checklist

Machine-checked (Linux, 2026-08-25 — `updater.test.ts`, and the probe with
a packaged build against a local fake release):

- [x] a tampered archive is refused at the hash step, nothing left on disk ✔
- [x] a sums file with a bad signature is refused before any download ✔
- [x] no pinned key → nothing fetched ✔; unsupported platform → nothing fetched ✔
- [x] the live shell fetches api → sums → signature → archive, unpacks beside
      itself, writes `.ready`, leaves no `.download`/`.partial`, records the
      once-per-version offer ✔
- [x] an OpenSSL `pkeyutl -rawin` signature verifies under WebCrypto ✔

By hand, still open:

- [ ] restart → the new version runs, the old directory is gone after the
      second start, `desktop.json` and the identity are intact (Linux and
      Windows)
- [ ] Windows: the Start-menu shortcut points at the new exe and toasts
      now say "chalk"
- [ ] update while hidden to the tray; the restart prompt waits for the user
- [ ] the fallback root (`userData/versions`) when the unpacked directory is
      read-only
- [ ] macOS, by hand: the swap at `/Applications` or `~/Applications`, the
      Dock pin still opens the new version, Gatekeeper does not re-prompt (no
      quarantine on bytes Node wrote), `chalk.app.old` gone after the second
      start

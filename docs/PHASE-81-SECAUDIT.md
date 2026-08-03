# Phase 81 — Security audit remediation

An external source-assisted security review of chalk, and what was done about
it. Unlike the other `PHASE-*.md` files this is not a plan the work was built
from — the work is done (81-1 … 81-6) and this is the record: what was
claimed, what was true, what was fixed, and what is deliberately still open.

**Audit.** Codex gpt-5.6-sol (high), 2026-08-03, against `401eda4` on `main`
(phase 80-16). Overall risk rated *Critical*. Twelve findings: 1 critical,
4 high, 4 medium, 2 low.

**Scope of the remediation.** Ten of the twelve are fixed. The two
cryptographic findings (C-01, H-01) are **confirmed and deliberately
deferred** — they need a signed key-distribution and message-envelope
protocol, not a patch, and that is its own phase. `docs/threat-model.md` was
rewritten to say so rather than continuing to claim a guarantee chalk does
not deliver.

## Every finding was verified against the code first

No finding was actioned on the strength of the report alone. That mattered:
it found two overstatements and, more usefully, three real problems the audit
did not.

| ID | Severity | Verdict | Outcome |
|---|---|---|---|
| C-01 | Critical | Confirmed | Deferred — see *Deliberately open* |
| H-01 | High | Confirmed | Deferred — see *Deliberately open* |
| H-02 | High | Confirmed, one overstatement | Fixed in 81-2 |
| H-03 | High | Confirmed | Fixed in 81-1 |
| H-04 | High | Confirmed | Fixed in 81-5 |
| M-01 | Medium | Confirmed | Fixed in 81-4 |
| M-02 | Medium | Confirmed | Fixed in 81-3 |
| M-03 | Medium | Confirmed | Fixed in 81-5 |
| M-04 | Medium | Confirmed but **not reachable** | Bumped anyway in 81-5 |
| L-01 | Low | Confirmed | Fixed in 81-3 |
| L-02 | Low | Confirmed, understated | Fixed in 81-6 |

### Where the audit was wrong

**H-02 overstated the gap.** It listed password change among the operations
protected "only by a session." It is not: `handleChangePassword` has always
required `current_auth_proof_b64` and verified it with `VerifyAuthProof`
before touching anything (`internal/auth/reset_http.go`). The recovery-phrase
rotation, TOTP replacement and passkey add/delete gaps were exactly as
described.

**M-04 (esbuild dev-server CORS) was not reachable.** GHSA-67mh-4wv8-2f99
affects `esbuild serve`. `web/build.mjs` uses only `esbuild.context()` +
`ctx.watch()` and `esbuild.build()`; the repo has no `serve` call anywhere,
and `npm run dev` is a filesystem watcher whose output the Go server serves.
The advisory had no path here. Bumped regardless, because a permanently
"known and accepted" advisory trains you to ignore the tool that reports it —
and `npm audit` is now clean, which is a signal worth having.

### What the audit missed

**The rate limiter it recommended expanding leaked memory.**
M-01 correctly said the anonymous endpoints need per-IP limits and pointed at
`internal/ratelimit` as the thing to reuse. But `Allow` wrote back
`r.hits[key] = kept` even when `kept` was empty, and nothing ever deleted a
key. Keyed by user ID (its only prior use) that is bounded by the user table.
Keyed by *client IP* — which is exactly what M-01 asks for — a distinct-IP
flood retains an entry per address forever. Applying the recommendation
without reading the implementation would have converted one DoS vector into
another. Fixed in 81-4 with key deletion plus an amortized once-per-window
sweep.

**Ephemeral guest rooms were fail-open for non-`chalkctl` deployments.**
`defaultEphemeralConfig()` returned `Enabled: true`, while the `chalkctl`
template wrote `CHALK_EPHEMERAL_ENABLED=false`. So the audited configuration
looked safe and a hand-rolled compose/k8s deployment got guest magic links on
by default. Mitigated in practice by the feature also needing
`CHALK_DB_URL_GUEST`, but fail-open is the wrong default for a feature whose
security property is *whoever holds the link is the guest*. Flipped to
`false` in 81-3; the template now writes the operator's choice explicitly
either way, and `chalkctl update` backfills `=true` so deployments that
relied on the old default keep working.

**Twenty-five reachable standard-library advisories.** M-03 reported exactly
two vulnerable dependency paths, both in modules. Running `govulncheck`
locally found those two *plus* 25 in the standard library, because `go.mod`
pinned `go 1.25.0` and the fixes landed in 1.25.2 through 1.25.12. The
auditor evidently scanned with a newer toolchain than the repo declares, so
the stdlib findings never appeared. Released images were unaffected
(`docker/Dockerfile` uses `golang:1.25-alpine`, which floats), but CI and
local builds used 1.25.0. 81-5 raises the `go` directive to 1.25.12.

`govulncheck ./...` now reports **zero** reachable vulnerabilities, and runs
in CI so this cannot rot again unnoticed.

## What was fixed

### 81-1 — Sessions survive nothing they shouldn't (H-03)

Changing or resetting credentials left every existing session alive, so the
one action a user takes *because* they think they are compromised did not
evict the attacker. Worse, sessions slid: `TouchSession` extended `expires_at`
by 30 days on every request with no reference to `created_at`, so a session
used at least monthly lived forever.

- Revocation runs **inside** the existing credential-change transactions
  (`ChangePasswordAuth`, `ResetAuthViaRecovery` in
  `internal/store/auth_v2_reset.go`), so the credential change and the
  revocation commit together or not at all.
- Password change keeps the caller's own session — it just proved the current
  password — and revokes every other. The token comes from
  `SessionTokenFromRequest(r)`, not from `SessionUser`, so there is no doubt
  about whether it is populated.
- Recovery reset revokes *everything*; the handler mints the caller a fresh
  session afterwards.
- Both then call `d.Kicker.CloseConnsForUser` so live WebSockets go with the
  sessions. The hub tracks connections per user, not per token, so password
  change also drops the caller's own socket; the SPA reconnects against its
  still-valid session. One blip, no new plumbing.
- `SessionMaxLifetime = 90 days`, enforced at all three sites that touch the
  table: `GetSession` (a stale row reads as absent), `TouchSession` (`LEAST`
  clamps the slide to `created_at + max`), and `DeleteExpiredSessions` (the
  janitor reaps over-age rows). No migration — `created_at` has existed since
  migration 0013 and was simply never consulted.

### 81-2 — Step-up authentication for factor rotation (H-02)

A session cookie proved "someone was signed in on this device once." That was
enough to mint a replacement recovery phrase, stage and confirm an
attacker-controlled TOTP secret, and enroll a passkey — i.e. to convert a
stolen session into permanent account ownership and lock the real owner out.

`internal/auth/stepup.go` adds `requireStepUp`: current password (as the same
`authProof` the login path derives) plus a live TOTP code, carried in the
request that uses them. No server-side grant, no new state — the same shape
`/password/change` has always used. It gates:

- `POST /api/auth/recovery/regenerate`
- `POST /api/auth/totp/enroll`
- `POST /api/auth/passkeys/add/begin` (not `finish`, which consumes the
  one-shot ceremony that `begin` just minted)
- `DELETE /api/auth/passkeys/{id}`

**The carve-out is the interesting part.** An account with no *confirmed*
TOTP secret is not asked for a code — there is no second factor to prove yet.
That is initial enrollment: the migration wizard, and re-enrollment after a
`reset_totp` recovery. Demanding a code there would be a lockout, so
`requireStepUp` checks `ua.TOTPConfirmed()` and there is a test pinning it
(`TestStepUpSkippedForInitialTOTPEnrollment`).

Two client flows already hold the proof in hand and pass it straight through
rather than re-prompting: `MigrationScreen` (derived moments earlier for
`migrationPassword`) and `RecoveryResetScreen` (carried in component state
from the reset to the TOTP re-enrollment two screens later). Everywhere else
gets `StepUpPrompt`, a shared confirm-it's-you form. The password is derived
to an `authProof` in the browser and never retained.

### 81-3 — The generated deployment was missing two settings (M-02, L-01)

Both were *implemented* server-side and never *wired* into what `chalkctl`
generates, which is the failure mode CLAUDE.md's env-config rule exists to
prevent: a new server env var is not done until chalkctl generates and
preserves it.

- **`CHALK_TRUSTED_PROXY=private`.** Without it chalkd sees the Caddy
  container as the peer for every request, so the phase-80 join limiter — and
  now everything in 81-4 — degrades to one bucket shared by the entire
  internet, and every session row records the proxy's address. The code
  comment at `internal/auth/sessions.go` describes this exact regression as
  *fixed*; the mechanism landed and the wiring did not.
- **`CHALK_AUTH_DECOY_KEY`.** Unset, chalkd generates a per-process key, so
  the fake KDF params served for unknown usernames change on every restart
  while real accounts' params stay put — which is itself the tell the decoys
  exist to hide.

Both follow the `CHALK_TOTP_ENC_KEY` pattern (generate fresh, preserve on
`--force`, backfill on `update`). The append-only backfill logic that
`ensureTOTPEncKey` had grown was factored into `appendEnvVar` and reused, so
there is one implementation of "add this line if and only if it is absent"
rather than four.

### 81-4 — The anonymous surface has budgets (M-01)

Every endpoint reachable without a session was free to spend the server's
CPU. TOTP's lockout is per *account*; it does nothing about an anonymous
caller working through many usernames, or one username from many directions.

- Per-IP sliding windows: 30/min on the general anonymous endpoints
  (register, authenticate, prelogin, login/password, login/totp, v2 signup),
  5/min on the Argon2-heavy recovery paths, which each cost a 64 MiB pass.
- A two-slot semaphore around every server-side Argon2 call, acquired inside
  `HashRecoveryWords` / `VerifyRecoveryCodeHash` so it covers all callers.
  Worst case 128 MiB of concurrent memory-hard work; blocking is the point.
- `CeremonyCache` and `SignupV2Cache` are size-capped (4096 / 512) with an
  inline prune first, so a full cache means genuinely live entries.
- The limiter map-growth bug described above.

Throttled responses are byte-identical regardless of whether the username
exists — a limiter that answered differently would hand back the enumeration
oracle the decoy KDF params exist to deny, and there is a test for it.

### 81-5 — Dependencies (H-04, M-03, M-04)

`pgx/v5` 5.7.1 → 5.9.2, `golang.org/x/text` 0.37.0 → 0.39.0, esbuild 0.24.0 →
0.25.12, `@playwright/test` 1.48.2 → 1.56.1, Go 1.25.0 → 1.25.12. All pinned
exactly, matching the repo's existing convention (`npm install`'s caret was
reverted by hand). `govulncheck` added to CI's `unit` job.

Note on Playwright: `test/e2e` is dormant (its CI job is `if: false` inside a
workflow whose push/PR triggers are commented out) and its Chromium is too
old to load the current UI anyway — the `run-chalk` skill keeps its own
`>=1.55` copy for that reason. Bumped regardless, since it is one line plus a
lockfile and leaving a known-vulnerable pin in the tree to explain later is
worse.

### 81-6 — The threat model said things that were not true (L-02)

`docs/threat-model.md` had drifted badly enough to be actively misleading. It
opened by asserting E2EE was live and the malicious-server goal met, then
later said only TLS protected content, that a subpoena yields plaintext, that
voice/video was out of scope (phase 30 shipped it), and quoted Argon2
parameters matching neither implementation. Sender authenticity was not
mentioned at all — not as a guarantee, not as a non-goal.

Rewritten from current invariants, leading with a **"Guarantees NOT met
today"** section covering C-01 and H-01 in full, with the bootstrap
key-substitution path spelled out. The claims that do hold are stated
precisely: the server cannot read message content *by accident* — backups,
logs, a stolen dump — which is the guarantee that genuinely holds and the one
most real compromises involve. `README.md`'s "blind relay" line was corrected
to match.

## Deliberately open

### C-01 — Channel-key wraps are not signed

Producing a valid wrap needs only the recipient's public X25519 key, which
the server stores. `unwrapV1` accepts anything that decrypts; there is no
signature, no signer identity in the `channel_keys` row, and no
trust-on-first-use pin comparing a newly unwrapped key against one already
held.

The sharpest path is bootstrap. The creator publishes its own wrap, reads it
back, and adopts whatever decrypts — the comment in
`web/src/crypto/channel-crypto.ts` explains this as converging with the
user's *other device*, but the only test applied is "does it open for me at
this slot." A server that answers that read-back with its own wrap has its
chosen key adopted **and then redistributed to every other member by the
legitimate creator**, which looks authentic to everyone.

Picture-word verification does not help: it covers identity keys, and nothing
in the client consults a peer's verification state before accepting a wrap.

**The fix** is a signed wrap envelope — Ed25519 over a canonical encoding of
channel ID, key version, recipient, wrap suite, wrap bytes and signer
identity — verified before the key is persisted, with an authenticated
channel-state transcript behind it so rotations and membership changes cannot
be forged either. That needs a `wrapper_id`/`wrap_sig` column, wire-frame
fields, and negative tests for substitution at bootstrap, recovery, member
addition and rotation. It also warrants an independent protocol review before
release.

### H-01 — Messages carry no sender signature

The AEAD associated data is `chalk-msg-s{suite}:{channelID}:{keyVersion}` and
nothing else. Sender, device, message ID, timestamp and thread relationship
are plaintext metadata the server attaches *outside* what is authenticated.
So a malicious server can replay a ciphertext under a different sender or
timestamp and decryption still succeeds; and since every member holds the
same symmetric key, ciphertext alone never proves which member authored it.

**The fix** is a signed message envelope binding sender identity and the
server-supplied metadata to a hash of the ciphertext, extended to edits,
reactions and attachment references — the same objects whose meaning depends
on server-supplied context.

### Why these are deferred rather than attempted

Both are protocol changes with wire, schema, client and migration surface,
and both are exactly the kind of work where a half-fix is worse than none: a
signature that is verified inconsistently, or a transcript that does not
actually bind membership changes, produces the *appearance* of the guarantee.
They are a phase, with a review, not a slice.

**The precedent to build from already exists in the repo.**
`web/src/voice/signal-crypto.ts` does this correctly for DTLS fingerprints:
a canonical, injective, domain-separated message
(`"chalk-voice-fp.v1"` + channel + from/to user + device), signed with the
Ed25519 identity key, verified fail-closed with the peer aborted on mismatch.
`fetchIdentity` (`web/src/crypto/identity-sync.ts`) already returns peer
Ed25519 keys with the X25519 self-signature checked locally. A
`chalk-wrap-sig.v1` and `chalk-msg-sig.v1` are near-copies of a pattern this
codebase has already got right once.

## Verification

Everything below is green at `fc8b2a1` (81-6):

```bash
go build ./... && go vet ./... && go test ./...   # + ./internal/... ./cmd/... with a DB
gofmt -l .                                        # empty
govulncheck ./...                                 # no vulnerabilities found
cd web && npx tsc --noEmit && node test.mjs && node build.mjs   # 1058 tests, 0 fail
npm audit                                         # 0 vulnerabilities, web/ and test/e2e/
```

New regression cover, all of it added with the fix it covers:

| Area | Tests |
|---|---|
| Session revocation, absolute lifetime | `test/integration/store_phase81_test.go` (5), `TestRecoveryResetRevokesSessions` |
| Step-up | `internal/auth/stepup_test.go` (4), `web/src/auth/stepup.test.ts` (2) |
| chalkctl env wiring | `TestEnvPhase81Settings`, `TestEnsurePhase81EnvBackfill` |
| Rate limits & caps | `internal/auth/anon_limit_test.go` (2), `TestRateLimiterEvictsIdleKeys`, `TestPutRefusesAtCapacity`, `TestSignupV2CachePutRefusesAtCapacity` |

**Known environmental issue:** the `test/integration` package cannot run
against the ad-hoc dev database — 63 tests fail in fixture cleanup with
`DM channel must have exactly 2 members` from orphaned DM channels left by UI
probes. This is pre-existing and unrelated to phase 81 (the failing set is
identical with the phase's changes stashed). Use `bootstrap/phase-03-postgres.sh`
for a clean fixture database.

## Follow-ups this surfaced (not phase 81)

- **The signed-envelope phase** for C-01 and H-01, per above. Until it lands,
  do not describe chalk as protecting content from a *malicious* server.
- **`chalkctl` cannot set the new env vars from its config file.**
  `CHALK_TRUSTED_PROXY` is a template literal and `CHALK_AUTH_DECOY_KEY` is
  generated; neither is an operator-settable `chalkctl.conf` key. Fine for
  the stock topology, wrong for anyone fronting chalk with their own proxy on
  a non-private network.
- **CI is still entirely dormant.** The `govulncheck` gate added in 81-5 is
  correct but inert: `.github/workflows/ci.yml` has its `push`/`pull_request`
  triggers commented out and the e2e job hard-disabled. Every check in this
  document was run by hand.
- **`web/dist` is still built without `NODE_ENV=production`** in
  `docker/Dockerfile` (a pre-existing item in CLAUDE.md's deferred list).
  Unminified bundles with inline sourcemaps are not a vulnerability, but they
  are a much larger attack-surface-reading convenience than they need to be.

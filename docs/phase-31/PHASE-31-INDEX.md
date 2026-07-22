# Phase 31 — Authentication v2 (password + TOTP default, passkeys optional)

**Status:** Spec complete. Implementation not started.
**Supersedes:** the passkey-only onboarding path from the multi-device arc (md-1…md-7).
**Does not change:** the E2E message/attachment layer, governance, or Phase 30 (voice/video).

## Why this phase exists

Platform passkeys are bound to one device's secure element. Setting up a passkey on a
PC leaves a new phone with no routine login path — only the recovery phrase, which is a
break-glass mechanism, not a daily driver. Phase 31 makes **password + TOTP** the
default, portable, cross-device credential, and demotes passkeys to an opt-in fast path
added later from the user profile.

The central realisation: in an E2E system a credential does two independent jobs —
**authenticate to the server** and **unlock the private-key bundle**. A platform passkey
is poor at the second job across devices; a password is naturally portable and good at
it. TOTP contributes nothing to key derivation and is therefore an authentication factor
only. Phase 31 separates the two jobs explicitly.

## Locked policy decisions

1. **Every account permanently carries a password and a TOTP secret.** Neither can be
   removed. There is no password-less or TOTP-less account state after enrollment.
2. **Password policy:** minimum 20 characters, must contain upper-case, lower-case,
   digit, and special character. Enforced **client-side** (see Addendum D §4 for why the
   server structurally cannot enforce it under E2E).
3. **TOTP gates every login**, regardless of first factor. A passkey replaces only the
   password-typing step on its device; it never replaces or skips the TOTP step.
4. **Passkeys are optional and added later** from the user profile. They are an
   additional unlock method for the Bundle Master Key, never a replacement for the
   password or TOTP.
5. **Migration is a hard cutover.** The server, not just the UI, blocks un-enrolled
   accounts from all non-enrollment API calls. Staged by `CHALK_AUTH_V2_REQUIRED`.

## Document map

| File | Contents |
|------|----------|
| `PHASE-31-AUTH-V2.md`            | Base spec: model, login/signup/reset flows, threat model, config |
| `PHASE-31-ADDENDUM-A-TOTP.md`    | TOTP server part: enroll/verify, enc-at-rest, skew, replay, lockout, backup codes |
| `PHASE-31-ADDENDUM-B-ENVELOPE.md`| Bundle Master Key envelope: per-method wraps, schema, key operations |
| `PHASE-31-ADDENDUM-C-MIGRATION.md`| Hard cutover: enrollment gate, flag, edge cases, rollout staging |
| `PHASE-31-ADDENDUM-D-CLIENT-CRYPTO.md`| Client crypto: Argon2id, HKDF split, password-policy enforcement, QR |
| `PHASE-31-SLICES.md`             | Build slices 31-1…31-9, scope / deliverables / verify / dependencies |

## Reading order

`PHASE-31-AUTH-V2.md` first, then Addendum B (the key model everything sits on), then
A / C / D in any order, then `PHASE-31-SLICES.md` to plan the build.

## Open items (not blocking spec)

- OPAQUE (asymmetric PAKE) is deferred. The authProof/KEK split gives a strong E2E
  property without it; OPAQUE would remove even authProof visibility and is a future
  hardening, not a v1 requirement.
- WebAuthn-as-second-factor (instead of TOTP) is out of scope; TOTP is the mandated
  second factor for v1.

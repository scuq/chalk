# Phase 31 — Addendum C: Migration (hard cutover)

## 1. Starting state

Existing accounts have a passkey (or passkeys) plus a recovery phrase, and no password or
TOTP. Under the current key model the private-key bundle is reachable via passkey PRF on
an enrolled device or via the recovery phrase elsewhere.

## 2. Cutover policy: hard

Enforcement is server-side, not merely UI. An account with `auth_v2_enrolled = false` is
blocked from every API route except the enrollment routes and the routes strictly needed
to reach them. This is gated by `CHALK_AUTH_V2_REQUIRED` (default `true`) so the operator
can stage rollout: set it `false` to let old and new coexist during testing, then `true`
to enforce.

## 3. Enrollment gate (middleware)

```
if CHALK_AUTH_V2_REQUIRED and session.user.auth_v2_enrolled == false:
    allow only:
        GET  /auth/migration/status
        POST /auth/login/passkey        # to obtain a session / migration token
        POST /auth/login/recovery       # alternative on a device without the passkey
        POST /auth/totp/enroll
        POST /auth/totp/confirm
        POST /auth/migration/complete
    reject everything else with 409 AUTH_V2_ENROLLMENT_REQUIRED
```

The client, on receiving `409 AUTH_V2_ENROLLMENT_REQUIRED`, routes the user into the
enrollment wizard regardless of what they were trying to do.

## 4. Enrollment flow

The device performing enrollment must be able to unlock the BMK first (via passkey PRF or
recovery phrase). BMK is held in memory only for the duration of the wizard.

```
1. Authenticate with existing method (passkey PRF or recovery) -> BMK in memory.
2. Set password: enforce policy client-side (>=20, composition).
   master = Argon2id(password, new auth_salt); authProof, KEK_password = HKDF split.
   wrap_password = seal(BMK, KEK_password).
3. Ensure wrap_recovery exists in envelope form; if the old bundle was not yet in BMK
   envelope form, perform the one-time re-wrap:
      generate/confirm BMK, bundle_enc = seal(existing_bundle, BMK),
      wrap_recovery = seal(BMK, KEK_recovery),
      re-wrap each existing passkey credential: wrap_passkey[N] = seal(BMK, KEK_passkey_N).
4. Enroll TOTP (Addendum A §4): enroll -> confirm with live code.
5. Generate backup codes; show once.
6. POST /auth/migration/complete {
      auth_salt, kdf_params, authProof, bundle_enc, wrap_password,
      wrap_recovery, wrap_passkey[], backup_code_hashes
   }
   server: within one s.withTx, write user_auth (+ passkey wraps), verify TOTP already
   confirmed, set auth_v2_enrolled = true.
```

Step 3 is the only step that touches `bundle_enc`; it runs at most once per account.

## 5. Edge cases

- **Fresh device at cutover, no local passkey, recovery phrase lost:** unrecoverable.
  This was already true before Phase 31 — migration does not worsen it. Surface it in
  onboarding copy so users export their recovery phrase before cutover.
- **Multiple passkeys:** re-wrap every credential's BMK wrap during step 3 so each
  enrolled device retains its fast path. A device whose passkey is not present at
  enrollment time can be re-added later from profile.
- **Partial enrollment interrupted:** nothing is committed until
  `/auth/migration/complete` succeeds; `auth_v2_enrolled` flips atomically. A user who
  abandons mid-wizard is simply still un-enrolled and re-enters the gate next time.
- **Admin-forced reset during migration window:** admin can invalidate sessions and force
  re-enrollment but cannot supply the BMK; the user still needs passkey or recovery to
  proceed (E2E boundary, base spec §9).

## 6. Rollout staging

1. Deploy with `CHALK_AUTH_V2_REQUIRED=false`. New signups already use v2; existing users
   unaffected. Verify new-signup and login flows.
2. Announce cutover date; prompt existing users to enroll (banner routes to wizard even
   while the gate is soft).
3. Flip `CHALK_AUTH_V2_REQUIRED=true`. Un-enrolled accounts hit the gate on next call.

## 7. Verification checklist

- Un-enrolled account is blocked from a normal API route with `409` when the flag is on.
- Enrollment wizard completes and flips `auth_v2_enrolled` atomically.
- `bundle_enc` is written exactly once per migrating account.
- Every pre-existing passkey retains a valid BMK wrap after enrollment.
- Login after enrollment requires TOTP on both password and passkey paths.

# Phase 31 — Addendum D: Client crypto and password policy

## 1. Libraries

- **Argon2id:** `hash-wasm` (WASM, works with esbuild / Node v22). Use `argon2id` with
  parameters mirrored from the server config so the same password reproduces the same
  `master` on any device.
- **HKDF / AES-GCM / random:** WebCrypto `crypto.subtle` (`deriveBits` HKDF-SHA-256,
  `encrypt`/`decrypt` AES-256-GCM, `getRandomValues`).
- **QR:** `qrcode` to render the `otpauth://` provisioning URI returned by the server.

## 2. Key derivation (client-side, never sent)

```
salt        = auth_salt                     # from server (public); new random at signup
master      = argon2id(password, salt, { m: kdf_mem_kib, t: kdf_iters, p: kdf_par })  // 32 bytes
authProof   = HKDF-SHA256(master, info="chalk/auth", 32)   // SENT to server
KEK_password= HKDF-SHA256(master, info="chalk/kek",  32)   // NEVER sent
```

The two HKDF `info` labels must be exactly these constants and must never collide.
`authProof` is what the server stores a hash of; `KEK_password` never leaves the browser.
Argon2id parameters travel with the account (`kdf_*` columns) so a future parameter bump
is a per-account migration rather than a global break.

## 3. Seal / unseal helpers

```
seal(plaintext, key):   nonce = random(12); ct = AES-256-GCM(key, nonce, plaintext); return nonce||ct
unseal(blob, key):      nonce = blob[0:12]; return AES-256-GCM-open(key, nonce, blob[12:])
```

Used for `bundle_enc`, `wrap_password`, `wrap_recovery`, `wrap_passkey`. Keep the format
byte-identical to the server's Addendum B §2 primitive.

## 4. Password policy is enforced client-side — and why the server cannot

The policy (>=20 chars; upper, lower, digit, special) is enforced in the client before
`master` is derived:

- Composition gate: reject until all four classes present and length >= 20.
- Strength meter: a zxcvbn-style estimator as advisory feedback on top of the hard gate.

The server structurally **cannot** enforce this: under E2E it never receives the
password, only `authProof`, which is an opaque 32-byte HKDF output that reveals nothing
about length or composition. What the server *can* enforce, and does, is:

- presence and shape of `authProof`,
- minimum Argon2id parameters (`kdf_mem_kib`, `kdf_iters`, `kdf_par` at or above the
  configured floor) — a client that lowballed parameters is rejected.

This is a deliberate client-trust boundary, identical to how Bitwarden treats master-
password policy. For a self-hosted app where the account owner sets their own password it
is the correct trade; document it so it is a known property, not a surprise. The
mitigation for the residual "weak password + DB leak" risk is the 20-char composition
policy itself plus the Argon2id cost floor.

## 5. TOTP enrollment UI

- Server returns `provisioning_uri` and `secret_b32`.
- Render the QR from `provisioning_uri`; also show `secret_b32` for manual entry.
- Require the user to type one live 6-digit code; POST to `/auth/totp/confirm`. Only on
  success is TOTP active.

## 6. Recovery phrase and backup codes

- Recovery phrase: shown once at signup / migration; the client derives `KEK_recovery`
  and produces `wrap_recovery` locally. Never transmit the phrase.
- Backup codes: generated client-side or server-side per the existing convention; the
  server stores only hashes. Shown once; downloadable/printable.

## 7. Sensitive-material handling

- Keep `password`, `master`, `KEK_*`, and `BMK` in local variables for the minimum
  lifetime; drop references as soon as the operation completes.
- Do not persist any of them to IndexedDB, localStorage, or logs. (Recall the standing
  lesson: distinguish IndexedDB cache issues from real holes — key material must never be
  in that cache.)
- Best-effort overwrite of `Uint8Array` buffers after use; note JS gives no guarantee, so
  minimising lifetime is the primary control.

## 8. Client test surface (`test.mjs`)

- Argon2id determinism: same password + salt + params -> identical `master` -> identical
  `authProof` and `KEK_password`.
- HKDF label separation: `authProof != KEK_password`, and neither is derivable from the
  other.
- seal/unseal round-trip for `bundle_enc` and each wrap.
- Envelope operations: change-password reseals only `wrap_password`; `bundle_enc`
  unchanged; add/remove passkey wrap leaves BMK reachable.
- Password policy gate: rejects <20 chars and any missing character class.

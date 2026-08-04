// chalk-web -- phase31-slice31-5 client auth crypto core.
//
// The client-side half of password auth (docs/PHASE-31-AUTHV2.md). The
// password NEVER leaves this module's outputs in recoverable form:
//
//   master       = Argon2id(password, salt, params)          [hash-wasm]
//   authProof    = HKDF-SHA256(master, info="chalk/auth")    -> SENT to server
//   KEK_password = HKDF-SHA256(master, info="chalk/kek")     -> NEVER sent
//
// The two HKDF info labels are independent: the server (which stores only
// SHA-256(authProof)) can never derive KEK_password. KEK_password seals the
// 32-byte BIP-39 ENTROPY of the encryption phrase (wrap suite 1: AES-256-GCM,
// nonce(12) || ct || tag, matching the server-side opaque-blob convention of
// identity_seed_wrap and 0032's suite-tagged style).
//
// Also here: the mandatory password policy (>= 20 chars; upper, lower, digit,
// special) and a small dependency-free strength estimate for the meter. The
// policy is enforced HERE because the server structurally cannot see the
// password (docs/PHASE-31-AUTHV2.md, "Password policy is client-side").

import { argon2id } from "hash-wasm";

// ---- parameters -----------------------------------------------------------

/** KDF parameters mirrored from the server (prelogin / enrollment). */
export interface KdfParams {
  alg: number; // 1 = argon2id (the only suite)
  memKiB: number;
  iters: number;
  par: number;
  salt: Uint8Array; // >= 16 bytes
}

/** Client defaults for NEW enrollments; must be >= the server floor
 * (CHALK_AUTH_ARGON2_*, default 256 MiB / 3 / 1). */
export const DEFAULT_KDF: Omit<KdfParams, "salt"> = {
  alg: 1,
  memKiB: 262144,
  iters: 3,
  par: 1,
};

/** Wrap suite 1: AES-256-GCM, blob = nonce(12) || ciphertext || tag(16). */
export const WRAP_SUITE_AESGCM = 1;

const HKDF_SALT = new TextEncoder().encode("chalk-auth-hkdf-salt-v1");
const INFO_AUTH = new TextEncoder().encode("chalk/auth");
const INFO_KEK = new TextEncoder().encode("chalk/kek");

// ---- derivation -----------------------------------------------------------

/** newAuthSalt returns 16 fresh random bytes for a new enrollment. */
export function newAuthSalt(): Uint8Array {
  const s = new Uint8Array(16);
  crypto.getRandomValues(s);
  return s;
}

async function hkdf32(master: Uint8Array, info: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", master as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT as BufferSource, info: info as BufferSource },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export interface DerivedAuth {
  /** Sent to the server (base64) as the login/enrollment proof. */
  authProof: Uint8Array;
  /** Never sent. Seals/unseals the identity-seed wrap. */
  kek: Uint8Array;
}

/**
 * deriveAuth runs Argon2id + the HKDF split. Deterministic for the same
 * (password, params): the same password reproduces the same authProof and KEK
 * on any device -- that determinism is what makes the password a portable
 * cross-device unlock root.
 */
export async function deriveAuth(password: string, params: KdfParams): Promise<DerivedAuth> {
  if (params.alg !== 1) throw new Error(`authkdf: unsupported kdf_alg ${params.alg}`);
  if (params.salt.length < 16) throw new Error("authkdf: salt must be >= 16 bytes");
  const master = await argon2id({
    password,
    salt: params.salt,
    iterations: params.iters,
    memorySize: params.memKiB,
    parallelism: params.par,
    hashLength: 32,
    outputType: "binary",
  });
  const authProof = await hkdf32(master, INFO_AUTH);
  const kek = await hkdf32(master, INFO_KEK);
  master.fill(0); // best-effort scrub; JS gives no guarantee
  return { authProof, kek };
}

// ---- seal / unseal (wrap suite 1) ----------------------------------------

/** seal encrypts plaintext under key (32B) as nonce(12) || ct || tag. */
export async function seal(plaintext: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  if (key.length !== 32) throw new Error("authkdf: seal key must be 32 bytes");
  const k = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  const nonce = new Uint8Array(12);
  crypto.getRandomValues(nonce);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce as BufferSource }, k, plaintext as BufferSource),
  );
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce, 0);
  out.set(ct, 12);
  return out;
}

/** unseal opens a blob produced by seal. Throws on tampering/wrong key. */
export async function unseal(blob: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  if (key.length !== 32) throw new Error("authkdf: unseal key must be 32 bytes");
  if (blob.length < 12 + 16) throw new Error("authkdf: blob too short");
  const k = await crypto.subtle.importKey("raw", key as BufferSource, "AES-GCM", false, [
    "decrypt",
  ]);
  const nonce = blob.slice(0, 12);
  const ct = blob.slice(12);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: nonce as BufferSource },
    k,
    ct as BufferSource,
  );
  return new Uint8Array(pt);
}

/** wrapEntropy seals the 32-byte encryption-phrase entropy under the KEK. */
export async function wrapEntropy(entropy: Uint8Array, kek: Uint8Array): Promise<Uint8Array> {
  if (entropy.length !== 32) throw new Error("authkdf: entropy must be 32 bytes");
  return seal(entropy, kek);
}

/** unwrapEntropy opens a wrap blob back to the 32-byte entropy. */
export async function unwrapEntropy(blob: Uint8Array, kek: Uint8Array): Promise<Uint8Array> {
  const pt = await unseal(blob, kek);
  if (pt.length !== 32) throw new Error("authkdf: unwrapped entropy has wrong length");
  return pt;
}

// ---- password policy ------------------------------------------------------

export interface PasswordPolicyResult {
  ok: boolean;
  /** Unmet requirements, empty when ok. Stable ids for the UI. */
  missing: Array<"length" | "upper" | "lower" | "digit" | "special">;
}

export const PASSWORD_MIN_LENGTH = 20;

/**
 * checkPasswordPolicy enforces the locked policy: >= 20 chars with upper,
 * lower, digit, and special. "Special" = any char that is not a letter or
 * digit (space counts: passphrases are encouraged).
 */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const missing: PasswordPolicyResult["missing"] = [];
  if ([...password].length < PASSWORD_MIN_LENGTH) missing.push("length");
  if (!/[A-Z]/.test(password)) missing.push("upper");
  if (!/[a-z]/.test(password)) missing.push("lower");
  if (!/[0-9]/.test(password)) missing.push("digit");
  if (!/[^A-Za-z0-9]/.test(password)) missing.push("special");
  return { ok: missing.length === 0, missing };
}

/**
 * estimateStrength is a small, dependency-free meter for UI feedback ONLY --
 * the hard gate is checkPasswordPolicy. Returns 0..4 (very weak .. very
 * strong) from a crude entropy estimate: charset size ^ length, penalised for
 * character repetition and sequential runs.
 */
export function estimateStrength(password: string): 0 | 1 | 2 | 3 | 4 {
  if (password.length === 0) return 0;
  let charset = 0;
  if (/[a-z]/.test(password)) charset += 26;
  if (/[A-Z]/.test(password)) charset += 26;
  if (/[0-9]/.test(password)) charset += 10;
  if (/[^A-Za-z0-9]/.test(password)) charset += 33;
  let bits = password.length * Math.log2(Math.max(charset, 2));
  // repetition penalty: unique-char ratio scales effective length
  const uniq = new Set(password).size;
  bits *= Math.max(0.5, uniq / password.length);
  // sequential-run penalty (abc, 123, aaa)
  let runs = 0;
  for (let i = 2; i < password.length; i++) {
    const a = password.charCodeAt(i - 2);
    const b = password.charCodeAt(i - 1);
    const c = password.charCodeAt(i);
    if ((b === a + 1 && c === b + 1) || (a === b && b === c)) runs++;
  }
  bits -= runs * 2;
  if (bits < 40) return 1;
  if (bits < 70) return 2;
  if (bits < 100) return 3;
  return 4;
}

// ---- small helpers --------------------------------------------------------

export function toB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const raw = atob(s);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

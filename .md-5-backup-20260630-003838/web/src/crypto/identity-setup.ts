// chalk -- pure logic for the identity-setup screen (crypto/idb-free where
// possible, so it can be unit-tested without a browser). The Preact screen
// (auth/IdentitySetupScreen.tsx) is a thin shell over these.
//
// Two jobs:
//   * the "prove you wrote it down" challenge at phrase generation:
//     pick N distinct word positions, then check the user's answers.
//   * verifying an entered phrase on a fresh device: derive the identity
//     and confirm its X25519 public key matches the one the account
//     already published (so a valid-but-wrong phrase is rejected, not
//     silently accepted).

import { deriveIdentityFromMnemonic, type DerivedIdentity } from "./identity";
import { validateMnemonic } from "./bip39";

/**
 * pickChallengeIndices returns `count` distinct word positions in
 * [0, total), chosen with crypto-strong randomness. Used to ask the user
 * to re-enter a few specific words after they've seen the phrase.
 */
export function pickChallengeIndices(count = 3, total = 24): number[] {
  if (count > total) throw new Error("pickChallengeIndices: count > total");
  const chosen = new Set<number>();
  while (chosen.size < count) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    chosen.add(buf[0] % total);
  }
  return [...chosen].sort((a, b) => a - b);
}

/** normalize a typed word for comparison (trim + lowercase). */
function norm(w: string): string {
  return w.trim().toLowerCase();
}

/**
 * checkChallenge returns true iff every answer matches the corresponding
 * word of the mnemonic. `answers` maps a word index (0-based) to the user's
 * typed word.
 */
export function checkChallenge(mnemonic: string, answers: Map<number, string>): boolean {
  const words = mnemonic.trim().split(/\s+/);
  if (answers.size === 0) return false;
  for (const [idx, typed] of answers) {
    if (idx < 0 || idx >= words.length) return false;
    if (norm(typed) !== norm(words[idx])) return false;
  }
  return true;
}

/** constant-time-ish byte compare (length-independent short-circuit ok here;
 *  these are public keys, not secrets). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Outcome of checking a typed phrase against the account's published key,
 * for the device-2 / fresh-device onboarding flow (md-1):
 *   * "ok"       -> well-formed phrase whose derived X25519 key matches the
 *                   published identity; `identity` is the derived keypair.
 *   * "invalid"  -> not a well-formed BIP-39 phrase (bad word, wrong count,
 *                   or failed checksum). Almost always a typo.
 *   * "mismatch" -> a VALID phrase, but it derives a DIFFERENT identity than
 *                   the one this account already published. The wrong phrase,
 *                   not a typo. This is the load-bearing rejection: it stops a
 *                   valid-but-wrong phrase from silently forking the identity
 *                   on this device.
 * Distinguishing "invalid" from "mismatch" lets the screen tell the user
 * whether to look for a typo or to re-check which phrase they're holding.
 */
export type EnteredPhraseResult =
  | { status: "ok"; identity: DerivedIdentity }
  | { status: "invalid" }
  | { status: "mismatch" };

/**
 * classifyEnteredPhrase validates the mnemonic checksum, derives the
 * identity, and confirms its X25519 public key matches
 * `expectedX25519Public` (the key the account already published), returning
 * a discriminated result. Never throws.
 *
 * Order matters: the checksum gate runs first so a mistyped phrase is
 * reported as "invalid" (a typo) before the comparatively expensive
 * PBKDF2/HKDF derivation, and is never conflated with the wrong-phrase
 * ("mismatch") case.
 */
export async function classifyEnteredPhrase(
  mnemonic: string,
  expectedX25519Public: Uint8Array,
): Promise<EnteredPhraseResult> {
  try {
    if (!(await validateMnemonic(mnemonic))) return { status: "invalid" };
    const identity = await deriveIdentityFromMnemonic(mnemonic);
    if (!bytesEqual(identity.x25519Public, expectedX25519Public)) {
      return { status: "mismatch" };
    }
    return { status: "ok", identity };
  } catch {
    return { status: "invalid" };
  }
}

/**
 * verifyEnteredPhrase is the boolean-style wrapper over
 * classifyEnteredPhrase: returns the derived identity on an exact match, or
 * null if the phrase is invalid OR derives a different identity. Never
 * throws. Prefer classifyEnteredPhrase when the caller wants to surface WHY
 * a phrase was rejected.
 */
export async function verifyEnteredPhrase(
  mnemonic: string,
  expectedX25519Public: Uint8Array,
): Promise<DerivedIdentity | null> {
  const result = await classifyEnteredPhrase(mnemonic, expectedX25519Public);
  return result.status === "ok" ? result.identity : null;
}

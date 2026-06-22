// chalk -- out-of-band identity verification ("safety number"). Phase 24.
//
// Two users confirm no man-in-the-middle substituted an identity key by
// comparing a short code derived from BOTH their long-term Ed25519 identity
// public keys, over a trusted side channel (in person, a phone call). The
// Ed25519 signing key is the root of trust: it self-signs the X25519 key
// (verified on every fetch), so pinning the Ed25519 key transitively pins the
// encryption key too.
//
// DERIVATION (must be byte-identical on both sides):
//   digest = SHA-256( "chalk-safety-number-v1" || k1 || k2 )
//   where {k1, k2} are the two 32-byte Ed25519 public keys sorted
//   byte-lexicographically -- so whoever computes it gets the same value
//   regardless of which key is "mine".
//
// RENDERINGS (two views of the same digest):
//   * words   -- 8 words from the BIP-39 wordlist (first 88 bits). The
//                comfortable form to read aloud. NOTE: this is NOT a BIP-39
//                mnemonic (no checksum) -- it's the wordlist used purely as an
//                11-bits-per-word codec, and must never be confused with a
//                recovery phrase.
//   * numeric -- 60 decimal digits from the digest, grouped in 5s. The
//                thorough fallback. Covers more of the fingerprint than the
//                words, so if a (2^88-infeasible) word collision were ever
//                forced, the number would still differ.
//
// The "verified" decision is stored LOCAL-ONLY (see idb.ts) -- a personal
// trust assertion the server can neither see nor forge. It pins the full
// digest + generation; any later key change makes the digest differ, which the
// status check surfaces as "changed" (re-verification required).

import { WORDLIST } from "./wordlist";

const SAFETY_LABEL = new TextEncoder().encode("chalk-safety-number-v1");
const WORD_COUNT = 8; // 8 * 11 = 88 bits
const NUMERIC_DIGITS = 60;

export interface SafetyNumber {
  /** Raw 32-byte SHA-256 fingerprint (canonical; stored for change-detection). */
  digest: Uint8Array;
  /** 8 BIP-39-wordlist words (read-aloud form). */
  words: string[];
  /** 60-digit decimal, grouped in 5s (thorough fallback). */
  numeric: string;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return a.length - b.length;
}

/**
 * computeSafetyNumber derives the verification code from two Ed25519 identity
 * public keys. Order-independent: computeSafetyNumber(a, b) and (b, a) yield
 * the same result, so both users see the same code.
 */
export async function computeSafetyNumber(
  edKeyA: Uint8Array,
  edKeyB: Uint8Array,
): Promise<SafetyNumber> {
  const [k1, k2] = compareBytes(edKeyA, edKeyB) <= 0 ? [edKeyA, edKeyB] : [edKeyB, edKeyA];
  const input = new Uint8Array(SAFETY_LABEL.length + k1.length + k2.length);
  input.set(SAFETY_LABEL, 0);
  input.set(k1, SAFETY_LABEL.length);
  input.set(k2, SAFETY_LABEL.length + k1.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return { digest, words: digestToWords(digest), numeric: digestToNumeric(digest) };
}

function bytesToBits(bytes: Uint8Array): string {
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  return bits;
}

/** digestToWords renders the first 88 bits as 8 wordlist words. */
function digestToWords(digest: Uint8Array): string[] {
  const bits = bytesToBits(digest.slice(0, 11)); // 88 bits
  const words: string[] = [];
  for (let i = 0; i < WORD_COUNT * 11; i += 11) {
    words.push(WORDLIST[parseInt(bits.slice(i, i + 11), 2)]);
  }
  return words;
}

/** digestToNumeric renders the digest as a 60-digit decimal, grouped in 5s. */
function digestToNumeric(digest: Uint8Array): string {
  let n = 0n;
  for (const b of digest) n = (n << 8n) | BigInt(b);
  // take the low NUMERIC_DIGITS decimal digits of the 256-bit integer
  const mod = 10n ** BigInt(NUMERIC_DIGITS);
  const s = (n % mod).toString().padStart(NUMERIC_DIGITS, "0");
  return s.replace(/(\d{5})(?=\d)/g, "$1 ");
}

// ---- verification status -------------------------------------------------

export type VerificationState = "unverified" | "verified" | "changed";

/** A stored verification record (local-only; see idb.ts). */
export interface VerificationRecord {
  peerUserID: string;
  digestHex: string; // the digest that was verified
  generation: number; // the peer's identity generation at verification
  verifiedAt: number; // epoch ms
}

export function digestToHex(digest: Uint8Array): string {
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * verificationState compares the CURRENT safety-number digest against a stored
 * record:
 *   - no record           -> "unverified"
 *   - record matches now   -> "verified"
 *   - record differs now   -> "changed" (key was substituted/rotated; the user
 *                              must re-verify out of band)
 */
export function verificationState(
  current: Uint8Array,
  stored: VerificationRecord | null,
): VerificationState {
  if (!stored) return "unverified";
  return stored.digestHex === digestToHex(current) ? "verified" : "changed";
}

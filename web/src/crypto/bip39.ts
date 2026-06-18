// chalk -- BIP-39 mnemonic phrase handling.
//
// The 24-word phrase is chalk's decryption root (see the crypto rebuild
// AMENDMENT): it seeds the user's X25519 + Ed25519 identity keypair in
// crypto/identity.ts. This module converts between entropy, mnemonic, and
// the PBKDF2 seed, using ONLY native WebCrypto (SHA-256 for the checksum,
// PBKDF2-HMAC-SHA512 for the seed) -- zero bundled crypto.
//
// chalk uses 24 words = 256-bit entropy exclusively. The functions accept
// the other BIP-39 sizes (12/15/18/21) for completeness and so the Trezor
// test vectors (which span sizes) validate the full code path, but
// generateMnemonic() always produces 256-bit/24-word phrases.
//
// NO passphrase ("25th word"): chalk's seed derivation always uses the
// empty passphrase, so the 24 words are the one and only secret. This
// keeps recovery simple -- there is no second factor to forget. The
// implementation is validated against the canonical Trezor BIP-39 vectors
// (entropy<->mnemonic, checksum, and the PBKDF2 seed parameters).

import { WORDLIST } from "./wordlist";

const ENTROPY_BITS_24_WORDS = 256;

// Index lookup is O(1) via this map (built once); indexOf would be O(n).
const WORD_INDEX: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  WORDLIST.forEach((w, i) => m.set(w, i));
  return m;
})();

function bytesToBits(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(2).padStart(8, "0");
  return s;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
}

// deriveChecksumBits returns the leading (entropyBytes*8 / 32) bits of
// SHA-256(entropy), as a "0"/"1" string. For 256-bit entropy this is 8 bits.
async function deriveChecksumBits(entropy: Uint8Array): Promise<string> {
  const csLen = (entropy.length * 8) / 32;
  const hash = await sha256(entropy);
  return bytesToBits(hash).slice(0, csLen);
}

/**
 * generateMnemonic creates a fresh 24-word (256-bit entropy) phrase using
 * the platform CSPRNG. This is the only generator chalk uses.
 */
export async function generateMnemonic(): Promise<string> {
  const entropy = new Uint8Array(ENTROPY_BITS_24_WORDS / 8); // 32 bytes
  crypto.getRandomValues(entropy);
  return entropyToMnemonic(entropy);
}

/**
 * entropyToMnemonic encodes entropy (16/20/24/28/32 bytes) into a BIP-39
 * mnemonic with its checksum word. Throws on invalid entropy length.
 */
export async function entropyToMnemonic(entropy: Uint8Array): Promise<string> {
  if (![16, 20, 24, 28, 32].includes(entropy.length)) {
    throw new Error(`bip39: entropy must be 16/20/24/28/32 bytes, got ${entropy.length}`);
  }
  const bits = bytesToBits(entropy) + (await deriveChecksumBits(entropy));
  const words: string[] = [];
  for (let i = 0; i < bits.length; i += 11) {
    words.push(WORDLIST[parseInt(bits.slice(i, i + 11), 2)]);
  }
  return words.join(" ");
}

/**
 * mnemonicToEntropy decodes + verifies a mnemonic, returning its entropy.
 * Throws if a word is unknown, the word count is invalid, or the checksum
 * does not match (i.e. a typo'd phrase is rejected rather than silently
 * producing the wrong identity).
 */
export async function mnemonicToEntropy(mnemonic: string): Promise<Uint8Array> {
  const words = normalizeMnemonic(mnemonic).split(" ");
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    throw new Error(`bip39: word count must be 12/15/18/21/24, got ${words.length}`);
  }
  let bits = "";
  for (const w of words) {
    const idx = WORD_INDEX.get(w);
    if (idx === undefined) throw new Error(`bip39: unknown word "${w}"`);
    bits += idx.toString(2).padStart(11, "0");
  }
  const dividerIndex = Math.floor(bits.length / 33) * 32;
  const entropyBits = bits.slice(0, dividerIndex);
  const checksumBits = bits.slice(dividerIndex);

  const entropy = new Uint8Array(entropyBits.length / 8);
  for (let i = 0; i < entropy.length; i++) {
    entropy[i] = parseInt(entropyBits.slice(i * 8, i * 8 + 8), 2);
  }
  const expected = await deriveChecksumBits(entropy);
  if (checksumBits !== expected) {
    throw new Error("bip39: invalid checksum (mistyped or corrupted phrase)");
  }
  return entropy;
}

/**
 * validateMnemonic returns true iff the mnemonic is well-formed and its
 * checksum matches. Never throws.
 */
export async function validateMnemonic(mnemonic: string): Promise<boolean> {
  try {
    await mnemonicToEntropy(mnemonic);
    return true;
  } catch {
    return false;
  }
}

/**
 * mnemonicToSeed derives the 64-byte BIP-39 seed via PBKDF2-HMAC-SHA512
 * (2048 iterations), with NO passphrase (salt = "mnemonic"). This is the
 * input to crypto/identity.ts's HKDF key derivation. The phrase should be
 * validated first; this function does not re-check the checksum.
 */
export async function mnemonicToSeed(mnemonic: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const password = enc.encode(normalizeMnemonic(mnemonic));
  const salt = enc.encode("mnemonic"); // no passphrase appended, by design
  const key = await crypto.subtle.importKey("raw", password, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: 2048, hash: "SHA-512" },
    key,
    512, // 64 bytes
  );
  return new Uint8Array(bits);
}

// normalizeMnemonic applies NFKD and collapses whitespace to single spaces,
// trimming ends -- matching BIP-39's canonicalization so seeds are stable
// regardless of incidental spacing/casing differences on input. (The
// English wordlist is all lowercase ASCII; we lowercase to be forgiving of
// user input, then split/join on whitespace.)
function normalizeMnemonic(mnemonic: string): string {
  return mnemonic.normalize("NFKD").trim().toLowerCase().split(/\s+/).join(" ");
}

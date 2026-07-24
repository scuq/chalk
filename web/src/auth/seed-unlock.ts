// chalk-web -- phase31-slice31-7 seed-wrap auto-unlock.
//
// The other half of seed-wrap.ts: at the post-login identity gate, if a
// password KEK is held from the login just completed, try to fetch the
// account's password-method seed wrap, unwrap the 32-byte entropy, and
// return the reconstructed 24-word encryption phrase. IdentitySetupScreen
// then verifies it against the published identity key exactly as if the
// user had typed it -- the verification step is NOT skipped, only the
// typing. Returns null on any failure (no KEK, no wrap, wrong suite,
// network error); the caller falls back to manual phrase entry.
//
// peekKEK (not takeKEK) is used so the KEK survives for seed-wrap.ts's
// upload path when this device ends up on the generate/enter flow after a
// failed unlock (e.g. no wrap stored yet).

import { entropyToMnemonic } from "../crypto/bip39";
import { unwrapEntropy, fromB64, WRAP_SUITE_AESGCM } from "../crypto/authkdf";
import { fetchSeedWraps } from "./login-v2-api";
import { peekKEK } from "./kek-holder";

/**
 * tryUnlockMnemonicFromWrap returns the encryption phrase reconstructed from
 * the server-stored password wrap, or null when that isn't possible. Never
 * throws.
 */
export async function tryUnlockMnemonicFromWrap(generation = 1): Promise<string | null> {
  const kek = peekKEK();
  if (!kek) return null;
  try {
    const wraps = await fetchSeedWraps(generation);
    const pw = wraps.find((w) => w.method === "password" && w.wrap_suite === WRAP_SUITE_AESGCM);
    if (!pw) return null;
    const entropy = await unwrapEntropy(fromB64(pw.wrap_b64), kek);
    const mnemonic = await entropyToMnemonic(entropy);
    entropy.fill(0);
    return mnemonic;
  } catch (e) {
    console.warn("seed-wrap unlock failed (falling back to phrase entry):", e);
    return null;
  }
}

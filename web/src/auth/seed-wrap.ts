// chalk-web -- phase31-slice31-6b seed-wrap upload helper.
//
// Called by IdentitySetupScreen right after an encryption phrase is
// established on this device (generated-and-confirmed, or entered and
// verified). If a password KEK is held from the wizard/login, wrap the
// phrase's 32-byte entropy under it and upload; a new device can then unlock
// keys with the password alone (fetch wrap -> unwrap -> derive identity)
// instead of re-typing 24 words.
//
// STRICTLY BEST-EFFORT: any failure (no KEK held, network down, server
// error) leaves the account fully functional -- the phrase itself remains
// the unlock path, and the wrap can be re-created at next login (31-7) or
// from the profile (31-8). Failures are logged, never surfaced as blocking
// errors, and never abort identity setup.

import { mnemonicToEntropy } from "../crypto/bip39";
import { wrapEntropy, toB64, WRAP_SUITE_AESGCM } from "../crypto/authkdf";
import { putSeedWrap } from "./signup-v2-api";
import { takeKEK } from "./kek-holder";

/**
 * maybeUploadSeedWrap wraps + uploads the entropy for `mnemonic` if a KEK is
 * held. Consumes the KEK either way (single-use hand-off). Never throws.
 */
export async function maybeUploadSeedWrap(mnemonic: string, generation = 1): Promise<void> {
  const kek = takeKEK();
  if (!kek) return;
  try {
    const entropy = await mnemonicToEntropy(mnemonic);
    const blob = await wrapEntropy(entropy, kek);
    entropy.fill(0);
    await putSeedWrap(generation, WRAP_SUITE_AESGCM, toB64(blob));
  } catch (e) {
    console.warn("seed-wrap upload failed (non-fatal; retry from profile):", e);
  } finally {
    kek.fill(0);
  }
}

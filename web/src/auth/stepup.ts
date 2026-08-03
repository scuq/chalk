// chalk-web -- 81-2 step-up proof for factor rotation.
//
// Rotating the recovery phrase, replacing the authenticator, or adding and
// removing passkeys now takes more than the session cookie: the server wants
// the current password's authProof and a live TOTP code with the request.
// See internal/auth/stepup.go for why.
//
// deriveStepUpProof recomputes the authProof exactly as the login path does
// (prelogin for the account's stored KDF params, then Argon2id). The password
// itself never leaves the browser, and the derived proof is not retained --
// each sensitive action asks again.

import { deriveAuth, toB64, fromB64 } from "../crypto/authkdf";
import { prelogin } from "./login-v2-api";

/** StepUpProof is the request-body fragment every gated endpoint accepts. */
export interface StepUpProof {
  auth_proof_b64: string;
  totp_code?: string;
}

/** deriveStepUpProof turns a typed password into the proof the server compares. */
export async function deriveStepUpProof(
  username: string,
  password: string,
): Promise<string> {
  const params = await prelogin(username);
  const { authProof } = await deriveAuth(password, {
    alg: params.kdf_alg,
    memKiB: params.kdf_mem_kib,
    iters: params.kdf_iters,
    par: params.kdf_par,
    salt: fromB64(params.salt_b64),
  });
  return toB64(authProof);
}

/** buildStepUp assembles the proof fragment, omitting a blank code. */
export async function buildStepUp(
  username: string,
  password: string,
  totpCode: string,
): Promise<StepUpProof> {
  const auth_proof_b64 = await deriveStepUpProof(username, password);
  const code = totpCode.trim();
  return code ? { auth_proof_b64, totp_code: code } : { auth_proof_b64 };
}

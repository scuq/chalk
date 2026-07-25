// chalk-web -- phase31-slice31-13 recovery-driven account reset.
//
//   POST /api/auth/recovery/reset-auth   recovery phrase -> new password
//
// Unauthenticated: the 24-word RECOVERY phrase (not the encryption phrase) is
// the credential. Returns a session cookie plus a freshly generated recovery
// phrase, since the submitted one is consumed by the reset.

import { SignupApiError } from "./signup-v2-api";

export interface ResetAuthInput {
  username: string;
  words: string[];
  auth_proof_b64: string;
  salt_b64: string;
  kdf_alg: number;
  kdf_mem_kib: number;
  kdf_iters: number;
  kdf_par: number;
  // reset_totp clears the TOTP secret for re-enrollment (lost authenticator).
  // When false the account's live totp_code is required instead.
  reset_totp: boolean;
  totp_code?: string;
}

export interface ResetAuthResult {
  user_id: string;
  username: string;
  recovery_words: string[];
  totp_reset: boolean;
}

export async function resetAuthViaRecovery(input: ResetAuthInput): Promise<ResetAuthResult> {
  const resp = await fetch("/api/auth/recovery/reset-auth", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    /* fall through */
  }
  if (!resp.ok) {
    const b = (body ?? {}) as { code?: string; message?: string };
    throw new SignupApiError(resp.status, b.code ?? "http_error", b.message ?? `HTTP ${resp.status}`);
  }
  return body as ResetAuthResult;
}

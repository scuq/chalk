// chalk-web -- phase31-slice31-8 profile security API client.
//
// Session-gated bindings for the account-security actions:
//   POST /api/auth/password/change   change password + re-sealed seed wrap
//   POST /api/auth/totp/enroll       stage a fresh TOTP secret (QR + b32)
//   POST /api/auth/totp/confirm      promote the staged secret (live code)

import { parseAuthResponse } from "../auth/signup-v2-api";
import type { StepUpProof } from "./stepup";

export interface ChangePasswordInput {
  current_auth_proof_b64: string;
  auth_proof_b64: string;
  salt_b64: string;
  kdf_alg: number;
  kdf_mem_kib: number;
  kdf_iters: number;
  kdf_par: number;
  generation: number;
  wrap_suite: number;
  wrap_b64: string;
}

export async function changePassword(input: ChangePasswordInput): Promise<void> {
  const resp = await fetch("/api/auth/password/change", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await parseAuthResponse<{ changed: boolean }>(resp);
}

export interface TOTPEnrollResult {
  provisioning_uri: string;
  secret_b32: string;
}

// totpEnroll stages a fresh secret. 81-2: REPLACING a confirmed
// authenticator takes a step-up proof; initial enrollment (no confirmed
// secret yet) passes the password alone, and the migration wizard has
// neither, so the proof is optional here and the server decides.
export async function totpEnroll(stepUp?: StepUpProof): Promise<TOTPEnrollResult> {
  const resp = await fetch("/api/auth/totp/enroll", {
    method: "POST",
    credentials: "same-origin",
    ...(stepUp
      ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(stepUp) }
      : {}),
  });
  return parseAuthResponse<TOTPEnrollResult>(resp);
}

export async function totpConfirm(code: string): Promise<void> {
  const resp = await fetch("/api/auth/totp/confirm", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  await parseAuthResponse<{ confirmed: boolean }>(resp);
}

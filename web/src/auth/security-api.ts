// chalk-web -- phase31-slice31-8 profile security API client.
//
// Session-gated bindings for the account-security actions:
//   POST /api/auth/password/change   change password + re-sealed seed wrap
//   POST /api/auth/totp/enroll       stage a fresh TOTP secret (QR + b32)
//   POST /api/auth/totp/confirm      promote the staged secret (live code)

import { SignupApiError } from "../auth/signup-v2-api";

async function parse<T>(resp: Response): Promise<T> {
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
  return body as T;
}

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
  await parse<{ changed: boolean }>(resp);
}

export interface TOTPEnrollResult {
  provisioning_uri: string;
  secret_b32: string;
}

export async function totpEnroll(): Promise<TOTPEnrollResult> {
  const resp = await fetch("/api/auth/totp/enroll", {
    method: "POST",
    credentials: "same-origin",
  });
  return parse<TOTPEnrollResult>(resp);
}

export async function totpConfirm(code: string): Promise<void> {
  const resp = await fetch("/api/auth/totp/confirm", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  await parse<{ confirmed: boolean }>(resp);
}

// chalk-web -- phase31-slice31-7 login-v2 API client.
//
// Wire bindings for the two-step password login plus the seed-wrap fetch:
//   POST /api/auth/login/prelogin   -> account KDF params + salt
//   POST /api/auth/login/password   -> totp_pending (no session)
//   POST /api/auth/login/totp       -> session (the only session-minting step)
//   GET  /api/auth/seed-wraps       -> password-wrapped entropy (new-device unlock)

import type { LoginResult } from "./types";
import { SignupApiError } from "./signup-v2-api";

async function parse<T>(resp: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    /* fall through */
  }
  if (!resp.ok) {
    const b = (body ?? {}) as { code?: string; message?: string };
    throw new SignupApiError(
      resp.status,
      b.code ?? "http_error",
      b.message ?? `HTTP ${resp.status}`,
    );
  }
  return body as T;
}

export interface PreloginResult {
  kdf_alg: number;
  kdf_mem_kib: number;
  kdf_iters: number;
  kdf_par: number;
  salt_b64: string;
}

export async function prelogin(username: string): Promise<PreloginResult> {
  const resp = await fetch("/api/auth/login/prelogin", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  return parse<PreloginResult>(resp);
}

export interface LoginPasswordResult {
  totp_pending: string;
  expires_at: string;
}

export async function loginPassword(
  username: string,
  authProofB64: string,
): Promise<LoginPasswordResult> {
  const resp = await fetch("/api/auth/login/password", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, auth_proof_b64: authProofB64 }),
  });
  return parse<LoginPasswordResult>(resp);
}

interface loginTOTPWire {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
  session_expires_at: string;
}

export async function loginTOTP(totpPending: string, code: string): Promise<LoginResult> {
  const resp = await fetch("/api/auth/login/totp", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ totp_pending: totpPending, code }),
  });
  const w = await parse<loginTOTPWire>(resp);
  return {
    userID: w.user_id,
    username: w.username,
    displayName: w.display_name,
    role: w.role,
    sessionExpiresAt: w.session_expires_at,
  };
}

export interface SeedWrapEntry {
  method: string;
  generation: number;
  wrap_suite: number;
  wrap_b64: string;
}

export async function fetchSeedWraps(generation = 1): Promise<SeedWrapEntry[]> {
  const resp = await fetch(`/api/auth/seed-wraps?generation=${generation}`, {
    method: "GET",
    credentials: "same-origin",
  });
  const body = await parse<{ wraps: SeedWrapEntry[] }>(resp);
  return body.wraps ?? [];
}

// chalk-web -- phase31-slice31-7 login-v2 API client.
//
// Wire bindings for the two-step password login plus the seed-wrap fetch:
//   POST /api/auth/login/prelogin   -> account KDF params + salt
//   POST /api/auth/login/password   -> totp_pending (no session), or on a
//                                      review instance (139-1) the session
//   POST /api/auth/login/totp       -> session (the session step, unless the
//                                      server is a review instance)
//   GET  /api/auth/seed-wraps       -> password-wrapped entropy (new-device unlock)

import type { LoginResult } from "./types";
import { parseAuthResponse } from "./signup-v2-api";

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
  return parseAuthResponse<PreloginResult>(resp);
}

/** The result of the password step of login. */
export type LoginPasswordResult =
  /** The TOTP step comes next, with this token. */
  | { kind: "totp"; totpPending: string }
  /** 139-1: a review instance gave the session without the TOTP step. */
  | { kind: "session"; result: LoginResult };

/**
 * Returns the result of the password step from the body of a 200 answer.
 * A body with a `totp_pending` token is the TOTP case. A body with a
 * `user_id` is the session case. Any other body throws.
 */
export function passwordLoginOutcome(body: Record<string, unknown>): LoginPasswordResult {
  if (typeof body.totp_pending === "string" && body.totp_pending !== "") {
    return { kind: "totp", totpPending: body.totp_pending };
  }
  if (typeof body.user_id === "string" && body.user_id !== "") {
    return { kind: "session", result: loginResultFromWire(body as unknown as loginTOTPWire) };
  }
  throw new Error("login/password: the answer has neither totp_pending nor user_id");
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
  return passwordLoginOutcome(await parseAuthResponse<Record<string, unknown>>(resp));
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
  return loginResultFromWire(await parseAuthResponse<loginTOTPWire>(resp));
}

// loginResultFromWire maps the session answer of the server to a LoginResult.
function loginResultFromWire(w: loginTOTPWire): LoginResult {
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
  const body = await parseAuthResponse<{ wraps: SeedWrapEntry[] }>(resp);
  return body.wraps ?? [];
}

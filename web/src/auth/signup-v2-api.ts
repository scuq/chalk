// chalk-web -- phase31-slice31-6b signup-v2 API client.
//
// Wire bindings for the auth-v2 endpoints (31-6a server side):
//   POST /api/auth/register/v2/begin    admission + TOTP provisioning
//   POST /api/auth/register/v2/finish   live TOTP verify -> account + session
//   PUT  /api/auth/seed-wrap            upload password-wrapped entropy
//
// Follows api.ts conventions: same-origin credentials, and one shared error
// decoder -- parseAuthResponse below, which login-v2, migration, security and
// recovery-reset all import.

import type { RegistrationResult } from "./types";

export class SignupApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "SignupApiError";
  }
}

// The server's error shape is {"error":{"code","message"}} -- writeError in
// internal/auth/http.go is the only thing that writes one, so it is the shape
// on every 4xx and 5xx across the auth surface.
//
// 81-7: four copies of this decoder read a FLAT {code, message} instead, so
// every failure arrived as code "http_error" and message "HTTP 401", and every
// screen that branched on a code was silently dead. One copy now, and the
// callers import it.
//
// Deliberately not api.ts's parseResponse, which decodes the same shape but
// throws ApiError -- every consumer of these modules branches on
// `instanceof SignupApiError`.
export async function parseAuthResponse<T>(resp: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    /* not JSON: a plain-text 404 from the mux lands on the fallback below */
  }
  if (!resp.ok) {
    const e = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new SignupApiError(
      resp.status,
      e?.code ?? "http_error",
      e?.message ?? `HTTP ${resp.status}`,
    );
  }
  return body as T;
}

export interface SignupV2BeginInput {
  username: string;
  display_name?: string;
  email?: string;
  invite_token?: string;
  admin_token?: string;
}

export interface SignupV2BeginResult {
  signup_token: string;
  provisioning_uri: string;
  secret_b32: string;
  expires_at: string;
}

export async function signupV2Begin(input: SignupV2BeginInput): Promise<SignupV2BeginResult> {
  // 31-11: an admin bootstrap URL (https://host/?admin_token=...) carries
  // the one-shot token that authorizes claiming the reserved admin
  // username. Attach it silently; the server ignores it for other names.
  if (!input.admin_token) {
    try {
      const t = new URLSearchParams(window.location.search).get("admin_token");
      if (t) input = { ...input, admin_token: t };
    } catch {
      /* non-browser test envs */
    }
  }
  const resp = await fetch("/api/auth/register/v2/begin", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseAuthResponse<SignupV2BeginResult>(resp);
}

export interface SignupV2FinishInput {
  signup_token: string;
  totp_code: string;
  auth_proof_b64: string;
  salt_b64: string;
  kdf_alg: number;
  kdf_mem_kib: number;
  kdf_iters: number;
  kdf_par: number;
}

interface signupV2FinishWire {
  user_id: string;
  username: string;
  display_name: string;
  recovery_words: string[];
  session_expires_at: string;
}

export async function signupV2Finish(input: SignupV2FinishInput): Promise<RegistrationResult> {
  const resp = await fetch("/api/auth/register/v2/finish", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const w = await parseAuthResponse<signupV2FinishWire>(resp);
  // Map to the existing RegistrationResult shape so the auth_registered
  // dispatch and RecoveryScreen work unchanged.
  return {
    userID: w.user_id,
    username: w.username,
    displayName: w.display_name,
    recoveryWords: w.recovery_words,
    sessionExpiresAt: w.session_expires_at,
  };
}

export interface AdminClaimProbe {
  claimable: boolean;
  username?: string;
}

/**
 * probeAdminClaim asks whether an /?admin_token= enrollment URL still
 * claims anything, and for which username, so the wizard can open
 * prefilled. Never throws on a bad token — the server answers
 * {claimable:false} — so callers can treat any failure as "not a claim
 * URL" and fall through to the normal login path.
 */
export async function probeAdminClaim(adminToken: string): Promise<AdminClaimProbe> {
  const resp = await fetch("/api/auth/admin-claim/probe", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ admin_token: adminToken }),
  });
  return parseAuthResponse<AdminClaimProbe>(resp);
}

/** putSeedWrap uploads the password-wrapped encryption-phrase entropy. */
export async function putSeedWrap(
  generation: number,
  wrapSuite: number,
  wrapB64: string,
): Promise<void> {
  const resp = await fetch("/api/auth/seed-wrap", {
    method: "PUT",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ generation, wrap_suite: wrapSuite, wrap_b64: wrapB64 }),
  });
  await parseAuthResponse<{ stored: boolean }>(resp);
}

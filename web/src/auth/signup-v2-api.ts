// chalk-web -- phase31-slice31-6b signup-v2 API client.
//
// Wire bindings for the auth-v2 endpoints (31-6a server side):
//   POST /api/auth/register/v2/begin    admission + TOTP provisioning
//   POST /api/auth/register/v2/finish   live TOTP verify -> account + session
//   PUT  /api/auth/seed-wrap            upload password-wrapped entropy
//
// Follows api.ts conventions: same-origin credentials, parseResponse-style
// error mapping (duplicated minimally here to avoid touching api.ts).

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
  return parse<SignupV2BeginResult>(resp);
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
  const w = await parse<signupV2FinishWire>(resp);
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
  await parse<{ stored: boolean }>(resp);
}

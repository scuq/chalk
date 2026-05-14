// chalk SPA -- auth HTTP client.
//
// Thin wrappers around fetch() for the three endpoints landed in
// 09b-3:
//
//   GET  /api/auth/config            → AuthConfig
//   POST /api/auth/register/begin    → CredentialCreationOptionsJSON
//   POST /api/auth/register/finish   → RegistrationResult
//
// Conventions:
//   - All requests use `credentials: "same-origin"` because future
//     endpoints (09b-4 onward) will set HttpOnly session cookies and
//     we want the cookie jar consistent today.
//   - All responses are inspected for the standard error shape
//     ({error: {code, message}}) and an ApiError is thrown so the
//     caller can surface the error code to the user.
//   - We do NOT try to be clever about retries or backoff. The
//     screens that drive these are interactive (single submit per
//     user action); retry is the user clicking Submit again.

import type {
  CredentialCreationOptionsJSON,
  AttestationResponseJSON,
} from "../webauthn";
import type { AuthConfig, RegistrationResult } from "./types";

// ApiError represents a structured server error. The code field is
// stable (see internal/auth/http.go); the message is human-readable.
export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

interface ServerError {
  error?: { code?: string; message?: string };
}

// throwIfError parses the response body, throws ApiError if it
// matches the standard error shape, otherwise returns the parsed
// JSON. Generic over the success shape.
async function parseResponse<T>(resp: Response): Promise<T> {
  // Try to parse JSON regardless of status; the server returns JSON
  // error bodies even on 4xx/5xx.
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    // Body wasn't JSON. For success status this is unexpected; for
    // error status, fall back to status-text.
    if (!resp.ok) {
      throw new ApiError(resp.status, "non_json_error", resp.statusText || "request failed");
    }
    throw new ApiError(resp.status, "non_json_success", "expected JSON body");
  }
  if (!resp.ok) {
    const e = (body as ServerError).error;
    throw new ApiError(
      resp.status,
      e?.code ?? "unknown_error",
      e?.message ?? resp.statusText ?? "request failed"
    );
  }
  return body as T;
}

// fetchAuthConfig fetches the public auth config the SPA needs at
// boot. Cacheable for ~60s server-side but we hit it once per session.
export async function fetchAuthConfig(): Promise<AuthConfig> {
  const resp = await fetch("/api/auth/config", {
    method: "GET",
    credentials: "same-origin",
  });
  return parseResponse<AuthConfig>(resp);
}

// RegisterBeginInput is the body of /api/auth/register/begin.
export interface RegisterBeginInput {
  username: string;
  display_name?: string;
  email: string;
  invite_token?: string;
}

// RegisterBeginResponse wraps the server's response. The Options
// field is what we hand to navigator.credentials.create().
interface RegisterBeginResponse {
  options: CredentialCreationOptionsJSON;
}

// registerBegin sends the form to /api/auth/register/begin and
// returns the WebAuthn options the authenticator needs.
export async function registerBegin(input: RegisterBeginInput): Promise<CredentialCreationOptionsJSON> {
  const resp = await fetch("/api/auth/register/begin", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await parseResponse<RegisterBeginResponse>(resp);
  return body.options;
}

// registerFinish sends the WebAuthn attestation response to
// /api/auth/register/finish and returns the user identity + recovery
// words. The words MUST be displayed once and never persisted.
export async function registerFinish(att: AttestationResponseJSON): Promise<RegistrationResult> {
  const resp = await fetch("/api/auth/register/finish", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential: att }),
  });
  // Server returns: {user_id, username, display_name, recovery_words}
  interface FinishResponse {
    user_id: string;
    username: string;
    display_name: string;
    recovery_words: string[];
  }
  const body = await parseResponse<FinishResponse>(resp);
  return {
    userID: body.user_id,
    username: body.username,
    displayName: body.display_name,
    recoveryWords: body.recovery_words,
  };
}

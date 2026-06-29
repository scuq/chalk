// chalk SPA -- auth HTTP client.
//
// Thin wrappers around fetch() for the auth endpoints:
//
//   GET  /api/auth/config              → AuthConfig
//   POST /api/auth/register/begin      → CredentialCreationOptionsJSON
//   POST /api/auth/register/finish     → RegistrationResult (+ Set-Cookie)
//   POST /api/auth/authenticate/begin  → CredentialAssertionOptionsJSON
//   POST /api/auth/authenticate/finish → LoginResult (+ Set-Cookie)
//   POST /api/auth/logout              → 204 (+ Set-Cookie clearing)
//   GET  /api/auth/me                  → MeResponse | null (401 on no session)
//
// Conventions:
//   - All requests use `credentials: "same-origin"` so the
//     chalk_session cookie travels in both directions automatically.
//   - All responses are inspected for the standard error shape
//     ({error: {code, message}}) and an ApiError is thrown so the
//     caller can surface the error code to the user.
//   - fetchMe is special: 401 is a NORMAL outcome (means "not logged
//     in"); it returns null instead of throwing so the bootstrap
//     path can branch cleanly on the result.
//   - We do NOT try to be clever about retries or backoff. The
//     screens that drive these are interactive (single submit per
//     user action); retry is the user clicking Submit again.

import type {
  CredentialCreationOptionsJSON,
  AttestationResponseJSON,
  CredentialAssertionOptionsJSON,
  AssertionResponseJSON,
} from "../webauthn";
import type { AuthConfig, LoginResult, MeResponse, RecoveryLoginResult, RegistrationResult } from "./types";

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
//
// As of 09b-5a the server also sets the chalk_session cookie on
// success and returns session_expires_at in the body. The cookie is
// the auth credential; session_expires_at is metadata for the SPA
// (e.g. "your session expires in 30 days").
export async function registerFinish(att: AttestationResponseJSON): Promise<RegistrationResult> {
  const resp = await fetch("/api/auth/register/finish", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential: att }),
  });
  interface FinishResponse {
    user_id: string;
    username: string;
    display_name: string;
    recovery_words: string[];
    session_expires_at: string;
  }
  const body = await parseResponse<FinishResponse>(resp);
  return {
    userID: body.user_id,
    username: body.username,
    displayName: body.display_name,
    recoveryWords: body.recovery_words,
    sessionExpiresAt: body.session_expires_at,
  };
}

// ---- authentication (login) -------------------------------------------

// authenticateBegin posts to /api/auth/authenticate/begin and returns
// the WebAuthn assertion options. Throws ApiError on server-side
// validation failures (bad_username, unknown_user, no_passkeys, etc).
export async function authenticateBegin(username: string): Promise<CredentialAssertionOptionsJSON> {
  const resp = await fetch("/api/auth/authenticate/begin", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username }),
  });
  interface BeginResponse {
    options: CredentialAssertionOptionsJSON;
  }
  const body = await parseResponse<BeginResponse>(resp);
  return body.options;
}

// authenticateFinish posts to /api/auth/authenticate/finish with the
// assertion response. On success the server Set-Cookies chalk_session
// and returns the user identity. The SPA never sees the cookie value
// directly (HttpOnly); subsequent calls to /api/auth/me discover the
// identity via the now-active session.
export async function authenticateFinish(att: AssertionResponseJSON): Promise<LoginResult> {
  const resp = await fetch("/api/auth/authenticate/finish", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential: att }),
  });
  interface FinishResponse {
    user_id: string;
    username: string;
    display_name: string;
    role: string;
    session_expires_at: string;
  }
  const body = await parseResponse<FinishResponse>(resp);
  return {
    userID: body.user_id,
    username: body.username,
    displayName: body.display_name,
    role: body.role,
    sessionExpiresAt: body.session_expires_at,
  };
}

// ---- session lifecycle ------------------------------------------------

// fetchMe checks the current session. Returns the user identity if
// logged in, or null if not (401). Distinct from other endpoints in
// that 401 is a normal outcome, not an error to throw on. The
// AuthGate bootstrap calls this at startup to decide between
// LoginScreen and a direct jump to chat.
//
// Other server errors (500, network failure) still throw so they
// can be surfaced to the user.
export async function fetchMe(): Promise<MeResponse | null> {
  let resp: Response;
  try {
    resp = await fetch("/api/auth/me", {
      method: "GET",
      credentials: "same-origin",
    });
  } catch (e) {
    // Network failure (no server, DNS, etc). Treat differently from
    // 401: this is a real error the user needs to see.
    throw new ApiError(0, "network_failure",
      e instanceof Error ? e.message : "could not reach server");
  }
  if (resp.status === 401) {
    // Drain the body to free the connection.
    await resp.body?.cancel();
    return null;
  }
  interface MeRaw {
    user_id: string;
    username: string;
    display_name: string;
    role: string;
    email: string;
    email_verified_at: string;
    session_expires_at: string;
  }
  const body = await parseResponse<MeRaw>(resp);
  return {
    userID: body.user_id,
    username: body.username,
    displayName: body.display_name,
    role: body.role,
    email: body.email,
    emailVerifiedAt: body.email_verified_at,
    sessionExpiresAt: body.session_expires_at,
  };
}

// logout posts to /api/auth/logout. Server clears the cookie and
// deletes the session row; this returns 204 on success. We don't
// expose any body. Idempotent: logging out twice is fine.
export async function logout(): Promise<void> {
  const resp = await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
  });
  if (resp.status !== 204 && !resp.ok) {
    // Try to parse an error body; this shouldn't happen in normal flow.
    let code = "logout_failed";
    let message = `unexpected status ${resp.status}`;
    try {
      const body = (await resp.json()) as ServerError;
      if (body.error?.code) code = body.error.code;
      if (body.error?.message) message = body.error.message;
    } catch {
      /* ignore JSON parse failure */
    }
    throw new ApiError(resp.status, code, message);
  }
  // Drain body if any (shouldn't be one on 204).
  await resp.body?.cancel();
}

// ---- recovery (sub-step 6) -------------------------------------------

// recoveryLogin posts to /api/auth/recovery with the 24-word phrase.
// On success the server Set-Cookies chalk_session and returns the
// identity. The returned regenerate_required is always true in 5b/6;
// the SPA MUST drive the user through regenerateRecovery() before
// letting them into chat.
export async function recoveryLogin(username: string, words: string[]): Promise<RecoveryLoginResult> {
  const resp = await fetch("/api/auth/recovery", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, words }),
  });
  interface FinishResponse {
    user_id: string;
    username: string;
    display_name: string;
    role: string;
    session_expires_at: string;
    regenerate_required: boolean;
  }
  const body = await parseResponse<FinishResponse>(resp);
  return {
    userID: body.user_id,
    username: body.username,
    displayName: body.display_name,
    role: body.role,
    sessionExpiresAt: body.session_expires_at,
    regenerateRequired: body.regenerate_required,
  };
}

// regenerateRecovery posts to /api/auth/recovery/regenerate. Requires
// an active session. Returns the freshly-generated 24-word phrase
// which MUST be displayed once and never persisted by the SPA.
export async function regenerateRecovery(): Promise<string[]> {
  const resp = await fetch("/api/auth/recovery/regenerate", {
    method: "POST",
    credentials: "same-origin",
  });
  interface RegResponse {
    recovery_words: string[];
  }
  const body = await parseResponse<RegResponse>(resp);
  return body.recovery_words;
}

// ---- phase 09c-2: invites + email change -------------------------------

// InviteDTO mirrors internal/auth/invites_http.go::inviteDTO. The
// timestamps are ISO strings; convert as needed at display time.
// Note: `url` and `note` are optional in JSON output (omitempty on the
// Go side); decoded as undefined when absent.
export interface InviteDTO {
  token: string;
  email: string;
  inviter_id: string;
  inviter_username?: string;
  note?: string;
  created_at: string;
  expires_at: string;
  used_at?: string;
  revoked_at?: string;
  status: "active" | "used" | "revoked" | "expired";
  url?: string;
}

// CreateInviteInput is the body of POST /api/invites.
export interface CreateInviteInput {
  email: string;
  note?: string;
}

// createInvite posts to /api/invites. Requires a session.
// Returns the created invite (201). Error codes the SPA may see:
//   - bad_email             (400)
//   - note_too_long         (400)
//   - email_taken           (409)  email already belongs to a user
//   - email_blacklisted     (403)
//   - invite_active         (409)  outstanding invite for this email
//   - lookup_failed         (500)
//   - persist_failed        (500)
export async function createInvite(input: CreateInviteInput): Promise<InviteDTO> {
  const resp = await fetch("/api/invites", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseResponse<InviteDTO>(resp);
}

// listMyInvites fetches the caller's invites. Requires a session.
// Newest first. Returns every invite regardless of status; the SPA
// filters/groups for display.
export async function listMyInvites(): Promise<InviteDTO[]> {
  const resp = await fetch("/api/invites/mine", {
    method: "GET",
    credentials: "same-origin",
  });
  interface ListResponse {
    invites: InviteDTO[] | null;
  }
  const body = await parseResponse<ListResponse>(resp);
  return body.invites ?? [];
}

// revokeInvite DELETEs /api/invites/{token}. Requires a session.
// Owner-checked at the server; non-owners get 404 (not 403). On
// success returns 204 No Content (no body).
//
// Error codes:
//   - invite_invalid_shape  (400)
//   - invite_not_found      (404)
//   - invite_not_active     (409)  already used/revoked/expired
export async function revokeInvite(token: string): Promise<void> {
  const resp = await fetch(`/api/invites/${encodeURIComponent(token)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (resp.status === 204) {
    await resp.body?.cancel();
    return;
  }
  // Error path: parse the JSON body for code+message.
  if (!resp.ok) {
    let body: unknown = null;
    try {
      body = await resp.json();
    } catch {
      throw new ApiError(resp.status, "revoke_failed",
        resp.statusText || "revoke failed");
    }
    const e = (body as ServerError).error;
    throw new ApiError(
      resp.status,
      e?.code ?? "revoke_failed",
      e?.message ?? "revoke failed"
    );
  }
  // 2xx but not 204 (unexpected). Drain.
  await resp.body?.cancel();
}

// PeekInviteResult mirrors the server's peekInviteResponse. The peek
// endpoint is public (no session) and is what RegisterFromInviteScreen
// calls on mount when ?invite=<token> is in the URL.
export interface PeekInviteResult {
  email: string;
  inviter_username: string;
  expires_at: string;
  status: "active" | "used" | "revoked" | "expired";
}

// peekInvite reads /api/auth/invite/{token}. No session required.
// 200 → active invite (returns result + status "active").
// 410 → exists but inactive (used/revoked/expired); returns result
//       with the relevant status; caller branches on it to show the
//       right copy.
// 404 → unknown token; throws ApiError (code "invite_not_found").
// 400 → malformed token; throws ApiError (code "invite_invalid_shape").
//
// The reason 410 is NOT thrown as an ApiError: the body shape is
// identical to the 200 success case and the SPA wants to render the
// inviter + email even for an unusable invite (so the user knows
// what address it was issued to). The status field carries the
// distinction.
export async function peekInvite(token: string): Promise<PeekInviteResult> {
  const resp = await fetch(`/api/auth/invite/${encodeURIComponent(token)}`, {
    method: "GET",
    credentials: "same-origin",
  });
  // Treat 200 AND 410 as "we have a result body"; 4xx other than 410
  // and any 5xx are ApiErrors.
  if (resp.status === 200 || resp.status === 410) {
    return (await resp.json()) as PeekInviteResult;
  }
  return parseResponse<PeekInviteResult>(resp);
}

// EmailChangeResult mirrors the server's emailChangeResponse. Returned
// by /api/auth/email-change after the SPA submits a new email; the
// actual change isn't complete until the user clicks the link in the
// verification email, but the SPA can show "we sent you an email"
// UX based on this response.
export interface EmailChangeResult {
  new_email: string;
  expires_at: string;
}

// startEmailChange posts to /api/auth/email-change. Requires a session.
// Server sends two emails (verify-to-new, notify-to-old) and stores
// the pending state. Returns 200 with the new email + expiry.
//
// Error codes:
//   - bad_email                (400)
//   - same_email               (400)  new === current
//   - email_blacklisted        (403)
//   - email_taken              (409)  another user has this email
//   - email_pending_elsewhere  (409)  another user has it pending too
//   - persist_failed           (500)
//   - lookup_failed            (500)
export async function startEmailChange(newEmail: string): Promise<EmailChangeResult> {
  const resp = await fetch("/api/auth/email-change", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_email: newEmail }),
  });
  return parseResponse<EmailChangeResult>(resp);
}

// VerifyEmailChangeResult mirrors the server's verifyEmailChangeResponse.
// Returned on a successful verify-email-change/{token} POST.
export interface VerifyEmailChangeResult {
  user_id: string;
  email: string;
}

// verifyEmailChange finalizes a pending email change. The token comes
// from the URL the user clicked in their new-address inbox. Session
// is OPTIONAL — the token alone authorizes the change (otherwise a
// user whose session expired between request and click couldn't
// complete it).
//
// Error codes:
//   - invite_invalid_shape  (400)  malformed token
//   - verify_failed         (410)  token bad/expired/already-used
//   - email_taken           (409)  rare race during the verify window
//   - verify_failed         (500)
export async function verifyEmailChange(token: string): Promise<VerifyEmailChangeResult> {
  const resp = await fetch(`/api/auth/verify-email-change/${encodeURIComponent(token)}`, {
    method: "POST",
    credentials: "same-origin",
  });
  return parseResponse<VerifyEmailChangeResult>(resp);
}

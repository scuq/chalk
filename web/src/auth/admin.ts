// chalk admin API client. Phase 09d-2.
//
// Wraps the server endpoints introduced in phase 09d-1:
//
//   GET    /api/admin/users
//   POST   /api/admin/users/{id}/block
//   POST   /api/admin/users/{id}/unblock
//   POST   /api/admin/users/{id}/soft-delete
//   DELETE /api/admin/users/{id}
//
//   GET    /api/admin/blacklist
//   POST   /api/admin/blacklist
//   DELETE /api/admin/blacklist/{email}
//
//   POST   /api/admin/bootstrap/begin
//   POST   /api/admin/bootstrap/finish
//
// All moderation endpoints require an admin session (cookie); the
// server's RequireAdmin middleware returns 403 not_admin otherwise.
// The bootstrap endpoints are unauthenticated; the token IS the
// credential.
//
// Error shape: same as auth/api.ts — ApiError with code + status +
// message. We re-import ApiError + parseResponse rather than duplicate
// them; admin endpoints share the wire-error contract with the rest
// of the auth surface.

import { ApiError } from "./api";
import type {
  CredentialCreationOptionsJSON,
  AttestationResponseJSON,
} from "../webauthn";

// ---- shared parser (mirrors auth/api.ts pattern) ----------------------

interface ServerError {
  error?: { code?: string; message?: string };
}

async function parseResponse<T>(resp: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    if (!resp.ok) {
      throw new ApiError(resp.status, "non_json_error",
        resp.statusText || "request failed");
    }
    // No-body success (204): just return undefined-shaped T. The
    // caller must accept undefined when their T is `void` or the
    // empty object.
    return undefined as unknown as T;
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

// parseEmpty handles 204 No Content responses where the body is
// genuinely empty. The fetch Response in that case still resolves;
// we just check status without trying to read JSON.
async function parseEmpty(resp: Response): Promise<void> {
  if (resp.status === 204) return;
  if (!resp.ok) {
    let code = "unknown_error";
    let message = resp.statusText || "request failed";
    try {
      const body = await resp.json();
      const e = (body as ServerError).error;
      if (e?.code) code = e.code;
      if (e?.message) message = e.message;
    } catch {
      // fall through with statusText
    }
    throw new ApiError(resp.status, code, message);
  }
  // 200/201 with a body we don't care about: still drain.
  try {
    await resp.text();
  } catch {
    // ignore
  }
}

// ---- moderation: users ------------------------------------------------

// AdminUser mirrors userSummaryDTO on the server. blocked_at /
// deleted_at / email_verified_at are ISO timestamps or absent.
export interface AdminUser {
  id: string;
  username: string;
  display_name: string;
  email: string;
  role: string;
  created_at: string;
  email_verified_at?: string;
  blocked_at?: string;
  deleted_at?: string;
  // Derived server-side: "active" | "blocked" | "deleted" | "admin".
  status: string;
}

export interface ListUsersResponse {
  users: AdminUser[];
  total: number;
  limit: number;
  offset: number;
}

// listUsers paginates the user table. q is a substring search across
// username/display_name/email; empty q returns all users. Default
// page size matches the server (50, capped at 200).
export async function listUsers(params: {
  q?: string;
  limit?: number;
  offset?: number;
}): Promise<ListUsersResponse> {
  const qs = new URLSearchParams();
  if (params.q && params.q.trim()) qs.set("q", params.q.trim());
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const resp = await fetch(`/api/admin/users${suffix}`, {
    method: "GET",
    credentials: "same-origin",
  });
  return parseResponse<ListUsersResponse>(resp);
}

export async function blockUser(userID: string): Promise<void> {
  const resp = await fetch(`/api/admin/users/${encodeURIComponent(userID)}/block`, {
    method: "POST",
    credentials: "same-origin",
  });
  await parseEmpty(resp);
}

export async function unblockUser(userID: string): Promise<void> {
  const resp = await fetch(`/api/admin/users/${encodeURIComponent(userID)}/unblock`, {
    method: "POST",
    credentials: "same-origin",
  });
  await parseEmpty(resp);
}

export async function softDeleteUser(userID: string): Promise<void> {
  const resp = await fetch(`/api/admin/users/${encodeURIComponent(userID)}/soft-delete`, {
    method: "POST",
    credentials: "same-origin",
  });
  await parseEmpty(resp);
}

export async function purgeUser(userID: string): Promise<void> {
  const resp = await fetch(`/api/admin/users/${encodeURIComponent(userID)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  await parseEmpty(resp);
}

// ---- moderation: blacklist -------------------------------------------

export interface BlacklistEntry {
  email: string;
  reason: string;
  added_at: string;
  added_by?: string;
  former_user_id?: string;
  former_username?: string;
}

export interface ListBlacklistResponse {
  entries: BlacklistEntry[];
  total: number;
  limit: number;
  offset: number;
}

export async function listBlacklist(params: {
  limit?: number;
  offset?: number;
}): Promise<ListBlacklistResponse> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const resp = await fetch(`/api/admin/blacklist${suffix}`, {
    method: "GET",
    credentials: "same-origin",
  });
  return parseResponse<ListBlacklistResponse>(resp);
}

export async function addToBlacklist(input: {
  email: string;
  reason: string;
}): Promise<void> {
  const resp = await fetch(`/api/admin/blacklist`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await parseEmpty(resp);
}

export async function removeFromBlacklist(email: string): Promise<void> {
  // Path-encode the email; the @ and + need to round-trip cleanly
  // and encodeURIComponent handles both.
  const resp = await fetch(`/api/admin/blacklist/${encodeURIComponent(email)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  await parseEmpty(resp);
}

// ---- bootstrap: first-run admin passkey enrollment -------------------

export interface AdminBootstrapBeginResponse {
  options: CredentialCreationOptionsJSON;
}

export interface AdminBootstrapFinishResponse {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
  recovery_words: string[];
  session_expires_at: string;
}

// bootstrapBegin submits the operator's bootstrap token and gets the
// WebAuthn attestation options. UNAUTHENTICATED — the token IS the
// credential. Returns the options shape expected by webauthn.ts's
// decodeCreationOptions (the {publicKey: ...} JSON shape that
// go-webauthn's BeginRegistration emits).
export async function bootstrapBegin(token: string): Promise<CredentialCreationOptionsJSON> {
  const resp = await fetch(`/api/admin/bootstrap/begin`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  const body = await parseResponse<AdminBootstrapBeginResponse>(resp);
  return body.options;
}

export async function bootstrapFinish(
  attestation: AttestationResponseJSON,
): Promise<AdminBootstrapFinishResponse> {
  const resp = await fetch(`/api/admin/bootstrap/finish`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ credential: attestation }),
  });
  return parseResponse<AdminBootstrapFinishResponse>(resp);
}

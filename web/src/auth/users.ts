// chalk user-lookup API client. Phase 09f (9.6).
//
// Wraps the single endpoint introduced in 9.6:
//
//   GET /api/users/lookup?username=<name>
//
// Purpose: lets the SPA resolve an arbitrary username to a UUID so
// that the existing friend_request WS frame (which takes a user_id)
// can be sent. Without this endpoint, the SPA couldn't initiate a
// friend request -- the wire frames existed but had no way to learn
// the recipient's UUID.
//
// Error codes returned by the server:
//   invalid_username  -- malformed input (HTTP 400)
//   not_found         -- no matching user, or match is the caller
//                        themselves, or the user is admin-blocked /
//                        admin-deleted (HTTP 404)
//   lookup_failed     -- DB error (HTTP 500)
//   no_session        -- not authed (HTTP 401, RequireSession path)
//
// We re-use the ApiError + parseResponse pattern from auth/api.ts.

import { ApiError } from "./api";

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

export interface UserLookupResult {
  user_id: string;
  username: string;
  display_name: string;
}

// lookupUser hits GET /api/users/lookup?username=<name>. Returns the
// matched user, or null when the server returns 404. Other errors
// (network, 500, 401) propagate as ApiError so the caller can
// distinguish "no match" from "lookup failed."
export async function lookupUser(username: string): Promise<UserLookupResult | null> {
  const trimmed = username.trim().toLowerCase();
  if (trimmed === "") {
    // Avoid hitting the server with an empty query; treat as miss.
    return null;
  }
  const resp = await fetch(
    `/api/users/lookup?username=${encodeURIComponent(trimmed)}`,
    {
      method: "GET",
      credentials: "include",
      headers: { Accept: "application/json" },
    }
  );
  if (resp.status === 404) {
    // Drain the body so the connection can be reused; the response
    // body is irrelevant to the null return.
    try { await resp.text(); } catch { /* ignore */ }
    return null;
  }
  return parseResponse<UserLookupResult>(resp);
}

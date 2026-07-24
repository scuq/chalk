// chalk-web -- phase31-slice31-9 migration API client.
//
//   POST /api/auth/migration/password   install password (un-enrolled only)
//   POST /api/auth/migration/complete   flip auth_v2_enrolled once pw+TOTP set
// (TOTP enroll/confirm reuse security-api.ts; both are enrollment-exempt.)

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
    throw new SignupApiError(resp.status, b.code ?? "http_error", b.message ?? `HTTP ${resp.status}`);
  }
  return body as T;
}

export interface MigrationPasswordInput {
  auth_proof_b64: string;
  salt_b64: string;
  kdf_alg: number;
  kdf_mem_kib: number;
  kdf_iters: number;
  kdf_par: number;
}

export async function migrationPassword(input: MigrationPasswordInput): Promise<void> {
  const resp = await fetch("/api/auth/migration/password", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await parse<{ stored: boolean }>(resp);
}

export async function migrationComplete(): Promise<void> {
  const resp = await fetch("/api/auth/migration/complete", {
    method: "POST",
    credentials: "same-origin",
  });
  await parse<{ enrolled: boolean }>(resp);
}

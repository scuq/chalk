// chalk-web -- phase31-slice31-13 recovery-driven account reset.
//
//   POST /api/auth/recovery/reset-auth   recovery phrase -> new password
//
// Unauthenticated: the 24-word RECOVERY phrase (not the encryption phrase) is
// the credential. Returns a session cookie plus a freshly generated recovery
// phrase, since the submitted one is consumed by the reset.

import { SignupApiError, parseAuthResponse } from "./signup-v2-api";

export interface ResetAuthInput {
  username: string;
  words: string[];
  auth_proof_b64: string;
  salt_b64: string;
  kdf_alg: number;
  kdf_mem_kib: number;
  kdf_iters: number;
  kdf_par: number;
  // reset_totp clears the TOTP secret for re-enrollment (lost authenticator).
  // When false the account's live totp_code is required instead.
  reset_totp: boolean;
  totp_code?: string;
}

export interface ResetAuthResult {
  user_id: string;
  username: string;
  recovery_words: string[];
  totp_reset: boolean;
}

export async function resetAuthViaRecovery(input: ResetAuthInput): Promise<ResetAuthResult> {
  const resp = await fetch("/api/auth/recovery/reset-auth", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  return parseAuthResponse<ResetAuthResult>(resp);
}

// resetErrorMessage turns a failed reset into a sentence for the screen.
//
// 81-7 merged everything the server can answer before the phrase verifies
// into one code, so this can no longer tell a wrong username from a spent
// phrase -- the server does not know which the caller deserves to be told,
// and guessing was the enumeration oracle. The merged sentence therefore has
// to carry the affordance the old "already used" message had: name the
// possibility and point at the admin.
//
// Lives here rather than in RecoveryResetScreen.tsx so it can be tested
// without pulling JSX into the node:test bundle.
export function resetErrorMessage(e: SignupApiError): string {
  switch (e.code) {
    case "bad_username":
      return "username must be 3-32 characters: lowercase letters, digits, and underscore";
    case "bad_phrase":
      return "that isn't a valid 24-word recovery phrase — check for typos; every word comes from the recovery word list";
    case "recovery_failed":
      return (
        "that username and recovery phrase don't match an account we can reset." +
        " Check the username, and check every word. If this phrase has already" +
        " been used once, it's spent — ask your admin for help getting back in."
      );
    case "code_used":
      return "that recovery phrase has already been used. Contact the admin if you're locked out.";
    case "user_blocked":
      return "this account has been blocked by an administrator.";
    case "user_deleted":
      return "this account has been deleted.";
    case "totp_required":
      return "this account has two-factor enabled: enter a code, or tick the box below to reset it";
    case "invalid_totp":
      return "that authenticator code didn't match. Wait for the next code and try again.";
    case "totp_locked":
      return "too many incorrect codes. Try again in a few minutes.";
    case "rate_limited":
      return "too many attempts from this address. Wait a minute and try again.";
    case "bad_auth_proof":
    case "bad_salt":
    case "kdf_params_too_weak":
      return "this browser derived key material the server rejected; please report this";
    default:
      return e.message;
  }
}

// LoginScreen: pre-chat login form. Phase 09b sub-step 5b.
//
// Inputs:
//   - username (required, lowercase a-z 0-9 _, 3-32 chars)
//
// On submit:
//   1. Call /api/auth/authenticate/begin → WebAuthn assertion options
//   2. Call navigator.credentials.get() via performAuthentication()
//   3. Call /api/auth/authenticate/finish with the assertion
//   4. Server Set-Cookies chalk_session and returns identity
//   5. Dispatch auth_logged_in → state machine flips to authed and
//      the chat UI renders (WS connects using the new cookie).
//
// Errors:
//   - User errors (unknown_user, no_passkeys, bad_username) render
//     inline as a banner above the form.
//   - WebAuthn errors (user_cancelled, security, constraint) render
//     with kind-specific copy ("cancelled", "no matching passkey",
//     "security check failed").
//   - Tech errors log to console and show generic message.

import type { LoginForm, LoginResult } from "./types";
import { authenticateBegin, authenticateFinish, ApiError } from "./api";
import { performAuthentication, WebAuthnError } from "../webauthn";

interface Props {
  form: LoginForm;
  onFieldChange: (field: keyof LoginForm, value: string) => void;
  onSubmitStart: () => void;
  onSubmitError: (code: string, message: string) => void;
  onLoggedIn: (result: LoginResult) => void;
  onGoRegister: () => void;
  // Phase 09b sub-step 6: "lost your passkey? recover" link.
  onGoRecovery?: () => void;
  // showRegisterLink is true when the server's open_registration is
  // true. When false, we still show the link but the server will
  // 403 (registration_closed); the RegisterScreen handles that
  // gracefully. Default true if config hasn't loaded yet.
  showRegisterLink?: boolean;
}

// USER_FACING_ERROR_CODES from the server that we render inline as
// a usable error message. Other codes are tech errors.
const USER_FACING_ERROR_CODES = new Set([
  "bad_username",
  "unknown_user",
  "no_passkeys",
]);

// errorMessageFor returns the message to display for a given error
// code. For known codes it's a friendly version; for unknown ones
// it's the server's message or a generic fallback.
function errorMessageFor(code: string | null, message: string | null): string {
  if (!code) return "";
  switch (code) {
    case "bad_username":
      return "username must be 3-32 characters: lowercase letters, digits, and underscore";
    case "unknown_user":
      return "that account doesn't exist, or has no passkeys";
    case "no_passkeys":
      return "that account exists but has no passkeys; use the recovery flow";
    case "user_cancelled":
      return "login cancelled";
    case "constraint":
      return "no matching passkey on this device";
    case "security":
      return "security check failed (RP ID or origin mismatch)";
    case "not_supported":
      return "your browser doesn't support WebAuthn (HTTPS required, or browser too old)";
    case "network_failure":
      return `cannot reach server: ${message ?? "unknown error"}`;
    default:
      // Tech errors: log to console for debugging, show generic.
      // (The caller already logged; just render a readable line.)
      if (USER_FACING_ERROR_CODES.has(code)) return message ?? "login failed";
      return "something went wrong; please try again";
  }
}

export function LoginScreen({
  form,
  onFieldChange,
  onSubmitStart,
  onSubmitError,
  onLoggedIn,
  onGoRegister,
  onGoRecovery,
  showRegisterLink = true,
}: Props) {
  const errorText = errorMessageFor(form.errorCode, form.errorMessage);

  // handleSubmit runs the full begin → ceremony → finish flow.
  // Errors are dispatched via onSubmitError so the form re-enables.
  async function handleSubmit(e: Event) {
    e.preventDefault();
    const username = form.username.trim().toLowerCase();
    if (username.length < 3) {
      onSubmitError("bad_username", "username too short");
      return;
    }
    onSubmitStart();
    try {
      const options = await authenticateBegin(username);
      const assertion = await performAuthentication(options);
      const result = await authenticateFinish(assertion);
      onLoggedIn(result);
    } catch (e) {
      if (e instanceof WebAuthnError) {
        onSubmitError(e.kind, e.message);
        return;
      }
      if (e instanceof ApiError) {
        onSubmitError(e.code, e.message);
        return;
      }
      // Unknown error class: log + generic.
      console.error("login failed:", e);
      onSubmitError("unknown",
        e instanceof Error ? e.message : "unknown error");
    }
  }

  return (
    <div class="chalk-auth">
      <div class="chalk-auth-card">
        <header class="chalk-auth-header">
          <h2>log in to chalk</h2>
          <p class="chalk-auth-subtitle">
            enter your username; we'll prompt for your passkey.
          </p>
        </header>

        {errorText && (
          <div class="chalk-auth-error" data-testid="login-error">
            {errorText}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div class="chalk-field">
            <label class="chalk-field-label" for="login-username">
              username
            </label>
            <input
              id="login-username"
              class="chalk-field-input"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellcheck={false}
              maxLength={32}
              minLength={3}
              value={form.username}
              disabled={form.busy}
              onInput={(e) => onFieldChange("username", (e.target as HTMLInputElement).value)}
              data-testid="login-username"
              autoFocus
            />
            <span class="chalk-field-hint">
              3-32 chars: lowercase a-z, digits, underscore
            </span>
          </div>

          <button
            type="submit"
            class="chalk-button chalk-button--primary"
            disabled={form.busy || form.username.trim().length < 3}
            data-testid="login-submit"
          >
            {form.busy ? "logging in..." : "log in with passkey"}
          </button>
        </form>

        {showRegisterLink && (
          <div class="chalk-auth-alt">
            no account?{" "}
            <button
              type="button"
              class="chalk-auth-link"
              onClick={onGoRegister}
              disabled={form.busy}
              data-testid="login-go-register"
            >
              register
            </button>
          </div>
        )}

        {onGoRecovery && (
          <div class="chalk-auth-alt">
            lost your passkey?{" "}
            <button
              type="button"
              class="chalk-auth-link"
              onClick={onGoRecovery}
              disabled={form.busy}
              data-testid="login-go-recovery"
            >
              recover with recovery code
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

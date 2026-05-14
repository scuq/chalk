// RegisterScreen: pre-chat registration form. Phase 09b sub-step 4.
//
// Inputs:
//   - username (required, lowercase a-z 0-9 _, 3-32 chars)
//   - display name (optional; defaults server-side to username)
//   - email (required; sketchy validation -- the server does the real check)
//   - invite token (optional; behind "show advanced" link)
//
// On submit:
//   1. Call /api/auth/register/begin → WebAuthn options
//   2. Call navigator.credentials.create() via performRegistration()
//   3. Call /api/auth/register/finish with the attestation
//   4. Dispatch auth_registered with the recovery words → state machine
//      flips to confirming-recovery and the RecoveryScreen renders.
//
// Errors:
//   - User errors (bad_username, username_taken, email_taken, etc.)
//     are inlined above the form.
//   - Tech errors (parse_failed, ceremony_validation_failed) are
//     logged to console + shown as a generic "Something went wrong"
//     message; the form re-enables so the user can retry.

import { useState } from "preact/hooks";
import type { RegistrationForm, AuthConfig, RegistrationResult } from "./types";
import { registerBegin, registerFinish, ApiError } from "./api";
import { performRegistration, WebAuthnError } from "../webauthn";

interface Props {
  form: RegistrationForm;
  config: AuthConfig;
  onFieldChange: (field: keyof RegistrationForm, value: string | boolean) => void;
  onSubmitStart: () => void;
  onSubmitError: (code: string, message: string) => void;
  onRegistered: (result: RegistrationResult) => void;
  // Phase 09b sub-step 5b: "have an account? log in" link.
  onGoLogin?: () => void;
}

// USER_FACING_ERROR_CODES is the set of server-returned error codes
// we render inline (the user can fix these). Other codes are tech
// errors -- log to console, show generic message.
const USER_FACING_ERROR_CODES = new Set([
  "bad_username",
  "username_reserved",
  "username_taken",
  "bad_email",
  "email_taken",
  "registration_closed",
]);

// fieldForErrorCode tells RegisterScreen WHICH form field to render
// the error next to. Returning null means render it as a banner above
// the form.
function fieldForErrorCode(code: string): keyof RegistrationForm | null {
  switch (code) {
    case "bad_username":
    case "username_reserved":
    case "username_taken":
      return "username";
    case "bad_email":
    case "email_taken":
      return "email";
    default:
      return null;
  }
}

export function RegisterScreen({
  form,
  config,
  onFieldChange,
  onSubmitStart,
  onSubmitError,
  onRegistered,
  onGoLogin,
}: Props) {
  // We don't keep form state here -- it's in the reducer so refresh-
  // through-rerenders preserve typing.
  const [showInvite, setShowInvite] = useState(form.showAdvanced);

  const fieldError =
    form.errorCode && USER_FACING_ERROR_CODES.has(form.errorCode)
      ? fieldForErrorCode(form.errorCode)
      : null;
  const bannerError =
    form.errorCode && form.errorMessage && (!USER_FACING_ERROR_CODES.has(form.errorCode) || fieldError === null)
      ? form.errorMessage
      : null;

  // Submit handler runs the 3-step ceremony. Async; we set busy=true
  // via onSubmitStart and reset via onSubmitError or onRegistered.
  const onSubmit = async (e: Event) => {
    e.preventDefault();
    if (form.busy) return;
    onSubmitStart();

    try {
      const opts = await registerBegin({
        username: form.username.trim().toLowerCase(),
        display_name: form.displayName.trim() || undefined,
        email: form.email.trim().toLowerCase(),
        invite_token: form.inviteToken.trim() || undefined,
      });
      const att = await performRegistration(opts);
      const result = await registerFinish(att);
      onRegistered(result);
    } catch (err) {
      if (err instanceof ApiError) {
        onSubmitError(err.code, err.message);
        return;
      }
      if (err instanceof WebAuthnError) {
        switch (err.kind) {
          case "not_supported":
            onSubmitError("webauthn_not_supported",
              "Your browser doesn't support WebAuthn, or this page isn't served over HTTPS.");
            return;
          case "user_cancelled":
            onSubmitError("webauthn_cancelled",
              "You cancelled the registration. Click 'Register' to try again.");
            return;
          case "constraint":
            onSubmitError("webauthn_constraint",
              "Your authenticator doesn't meet the requirements.");
            return;
          case "security":
            onSubmitError("webauthn_security",
              "Security check failed. Make sure you're on the right domain.");
            return;
          default:
            console.error("webauthn unknown error:", err);
            onSubmitError("webauthn_unknown", "Registration failed; see browser console.");
            return;
        }
      }
      console.error("register: unexpected error:", err);
      onSubmitError("unexpected", "Registration failed unexpectedly; see browser console.");
    }
  };

  return (
    <div class="chalk-auth" data-testid="register-screen">
      <div class="chalk-auth-card">
        <header class="chalk-auth-header">
          <h2>register</h2>
          <p class="chalk-auth-subtitle">
            create your chalk account with a passkey
          </p>
        </header>

        {bannerError && (
          <div class="chalk-auth-error" data-testid="register-error-banner">
            {bannerError}
          </div>
        )}

        <form class="chalk-auth-form" onSubmit={onSubmit} data-testid="register-form">
          <div class="chalk-field">
            <label class="chalk-field-label" for="register-username">
              username
            </label>
            <input
              id="register-username"
              class="chalk-field-input"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellcheck={false}
              required
              minLength={3}
              maxLength={32}
              pattern="[a-z0-9_]{3,32}"
              value={form.username}
              disabled={form.busy}
              onInput={(e) => onFieldChange("username", (e.target as HTMLInputElement).value)}
              data-testid="register-username"
            />
            <span class="chalk-field-hint">
              3–32 chars; lowercase letters, digits, underscore
            </span>
            {fieldError === "username" && (
              <span class="chalk-field-error" data-testid="register-username-error">
                {form.errorMessage}
              </span>
            )}
          </div>

          <div class="chalk-field">
            <label class="chalk-field-label" for="register-display-name">
              display name <span class="chalk-field-optional">(optional)</span>
            </label>
            <input
              id="register-display-name"
              class="chalk-field-input"
              type="text"
              autoComplete="name"
              maxLength={80}
              value={form.displayName}
              disabled={form.busy}
              onInput={(e) => onFieldChange("displayName", (e.target as HTMLInputElement).value)}
              data-testid="register-display-name"
            />
            <span class="chalk-field-hint">
              what others see; defaults to your username
            </span>
          </div>

{!config.dev_mode && (
          <div class="chalk-field">
            <label class="chalk-field-label" for="register-email">
              email
            </label>
            <input
              id="register-email"
              class="chalk-field-input"
              type="email"
              autoComplete="email"
              autoCapitalize="none"
              value={form.email}
              disabled={form.busy}
              onInput={(e) => onFieldChange("email", (e.target as HTMLInputElement).value)}
              data-testid="register-email"
            />
            <span class="chalk-field-hint">
              used for recovery; never shown to other users
            </span>
            {fieldError === "email" && (
              <span class="chalk-field-error" data-testid="register-email-error">
                {form.errorMessage}
              </span>
            )}
          </div>
          )}

          {/* Advanced: invite token. Shown only when needed (closed
              registration) OR when user clicks the toggle. */}
          {(!config.open_registration || showInvite) && (
            <div class="chalk-field" data-testid="register-invite-field">
              <label class="chalk-field-label" for="register-invite">
                invite token{" "}
                {config.open_registration ? (
                  <span class="chalk-field-optional">(optional)</span>
                ) : (
                  <span class="chalk-field-required">(required)</span>
                )}
              </label>
              <input
                id="register-invite"
                class="chalk-field-input"
                type="text"
                autoComplete="off"
                spellcheck={false}
                value={form.inviteToken}
                disabled={form.busy}
                onInput={(e) => onFieldChange("inviteToken", (e.target as HTMLInputElement).value)}
                data-testid="register-invite"
              />
              <span class="chalk-field-hint">
                {config.open_registration
                  ? "leave blank unless you have one"
                  : "ask an existing user for an invite"}
              </span>
            </div>
          )}

          {config.open_registration && !showInvite && (
            <button
              type="button"
              class="chalk-auth-link"
              onClick={() => {
                setShowInvite(true);
                onFieldChange("showAdvanced", true);
              }}
              data-testid="register-show-advanced"
            >
              show advanced
            </button>
          )}

          <button
            type="submit"
            class="chalk-button chalk-button--primary"
            disabled={form.busy}
            data-testid="register-submit"
          >
            {form.busy ? "registering..." : "register"}
          </button>

          <div class="chalk-auth-meta">
            <span>RP: {config.rp_name}</span>
            {config.dev_mode && <span class="chalk-auth-meta-dev">DEV</span>}
            {config.open_registration && (
              <span class="chalk-auth-meta-warn">OPEN REGISTRATION</span>
            )}
          </div>
        </form>

        {onGoLogin && (
          <div class="chalk-auth-alt">
            have an account?{" "}
            <button
              type="button"
              class="chalk-auth-link"
              onClick={onGoLogin}
              disabled={form.busy}
              data-testid="register-go-login"
            >
              log in
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

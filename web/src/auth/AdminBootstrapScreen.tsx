// AdminBootstrapScreen: first-run admin passkey enrollment.
// Phase 09d-2.
//
// Shown when the SPA boots with ?admin_bootstrap=<token> in the URL.
// The token comes from chalkd's stderr banner that's printed once on
// first startup when CHALK_ADMIN_USERNAME / CHALK_ADMIN_EMAIL are set
// and no admin row exists yet. AuthGate routes here ahead of the /me
// fetch (URL params win over session state).
//
// Flow:
//   1. Component mounts with the token.
//   2. User clicks "Register admin passkey".
//   3. We call /api/admin/bootstrap/begin with the token.
//   4. Server returns WebAuthn options for the admin row that's
//      already in the DB. We invoke navigator.credentials.create()
//      via performRegistration().
//   5. We call /api/admin/bootstrap/finish with the attestation.
//   6. Server attaches the passkey, mints the session cookie, and
//      returns identity + recovery words. We dispatch
//      auth_admin_bootstrapped which transitions to confirming-recovery
//      (the same screen RegisterScreen uses) so the operator sees
//      and copies their recovery words. After confirming,
//      App.tsx detects me.role === "admin" and redirects to /admin.
//
// Error modes (server codes mapped to user copy):
//   - bad_token / token_mismatch / no_active_token → invalid token
//     banner with "ask the operator to reissue" suggestion.
//   - admin_already_enrolled → "this admin is already set up; log in
//     normally" with a link back to /.
//   - webauthn_* → standard ceremony failure copy.
//
// The token comes in via a prop (extracted from the URL by AuthGate
// at mount time). We don't read window.location ourselves so this
// component is easy to test in isolation.

import { useState } from "preact/hooks";
import { ApiError } from "./api";
import { bootstrapBegin, bootstrapFinish } from "./admin";
import { performRegistration, WebAuthnError } from "../webauthn";
import type { RegistrationResult } from "./types";

interface Props {
  token: string;
  busy: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  onSubmitStart: () => void;
  onSubmitError: (code: string, message: string) => void;
  // onBootstrapped: called on success. The result has the same shape
  // RegistrationResult uses so we can transition directly into the
  // shared confirming-recovery stage.
  onBootstrapped: (result: RegistrationResult) => void;
  // onDismiss: called when the user clicks "go to login instead",
  // e.g. when admin_already_enrolled fires and they realize they
  // need to use a different flow.
  onDismiss: () => void;
}

export function AdminBootstrapScreen({
  token,
  busy,
  errorCode,
  errorMessage,
  onSubmitStart,
  onSubmitError,
  onBootstrapped,
  onDismiss,
}: Props) {
  // Local UI state: whether the operator has confirmed they're
  // ready (we don't auto-fire the ceremony on mount because the
  // browser prompt is intrusive and the operator may want to read
  // the page first). Once they click "Register", busy gates the
  // button.
  const [confirmed, setConfirmed] = useState(false);

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    if (busy) return;
    onSubmitStart();
    setConfirmed(true);
    try {
      const opts = await bootstrapBegin(token);
      const att = await performRegistration(opts);
      const result = await bootstrapFinish(att);
      // Map server response into RegistrationResult shape so the
      // existing confirming-recovery flow can render it.
      onBootstrapped({
        userID: result.user_id,
        username: result.username,
        displayName: result.display_name,
        recoveryWords: result.recovery_words,
        sessionExpiresAt: result.session_expires_at,
      });
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
            onSubmitError("webauthn_unknown",
              "Registration failed; see browser console.");
            return;
        }
      }
      console.error("admin-bootstrap: unexpected error:", err);
      onSubmitError("unexpected",
        "Bootstrap failed unexpectedly; see browser console.");
    }
  };

  // Specific error codes get cleaner copy. Anything else falls back
  // to errorMessage from the server.
  const friendlyError = ((): string | null => {
    if (!errorCode) return null;
    switch (errorCode) {
      case "bad_token":
        return "The bootstrap token in this URL is malformed. " +
          "Ask the operator to share the URL again from chalkd's stderr.";
      case "token_mismatch":
        return "The bootstrap token doesn't match the active one. " +
          "It may have been rotated since the URL was issued.";
      case "no_active_token":
        return "There's no active bootstrap token on the server. " +
          "Ask the operator to reissue (restart chalkd; the banner " +
          "prints to stderr).";
      case "admin_already_enrolled":
        return "An admin passkey is already registered. " +
          "If that's you, log in normally; otherwise contact the operator.";
      case "no_admin_row":
        return "Server-side state is inconsistent: a bootstrap " +
          "token exists but no admin user. Operator intervention needed.";
      default:
        return errorMessage;
    }
  })();

  // admin_already_enrolled is a terminal state: no retry. We hide
  // the submit button and show a "go to login" link.
  const enrolled = errorCode === "admin_already_enrolled";

  return (
    <div class="chalk-auth" data-testid="admin-bootstrap-screen">
      <div class="chalk-auth-card">
        <header class="chalk-auth-header">
          <h2>admin bootstrap</h2>
          <p class="chalk-auth-subtitle">
            register the first administrator passkey
          </p>
        </header>

        <p class="chalk-auth-prose">
          This URL was printed to chalkd's stderr when the server
          started with <code>CHALK_ADMIN_USERNAME</code> set. Visiting
          it once registers the admin's passkey and logs you in.
          Then the URL becomes inert.
        </p>

        {friendlyError && (
          <div class="chalk-auth-error" data-testid="admin-bootstrap-error">
            {friendlyError}
          </div>
        )}

        {!enrolled && (
          <form
            class="chalk-auth-form"
            onSubmit={onSubmit}
            data-testid="admin-bootstrap-form"
          >
            <p class="chalk-auth-prose">
              Clicking the button below will prompt you to create a
              passkey on this device. After registration you'll see
              your 24-word recovery code — write it down or save it
              securely, because it's the only way back in if you
              lose access to this passkey.
            </p>
            <button
              type="submit"
              class="chalk-button chalk-button--primary"
              disabled={busy || confirmed}
              data-testid="admin-bootstrap-submit"
            >
              {busy ? "registering..." : "Register admin passkey"}
            </button>
          </form>
        )}

        {enrolled && (
          <div class="chalk-auth-actions">
            <button
              type="button"
              class="chalk-button"
              onClick={onDismiss}
              data-testid="admin-bootstrap-go-login"
            >
              Go to login
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

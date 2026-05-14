// AuthGate: branch on authStage and render the right pre-chat
// screen. Owns the GET /api/auth/config fetch at boot.
//
// Stages it handles:
//   - bootstrapping     → loading spinner / placeholder
//   - registering       → <RegisterScreen>
//   - confirming-recovery → <RecoveryScreen>
//   - transitional-handoff → small "Continue to chat" notice
//   - authed            → not handled here (App renders chat directly)
//
// Phase 09b sub-step 4. Sub-step 09b-5 will add the "logging-in" stage
// and the session-handoff handler that replaces transitional-handoff.

import { useEffect } from "preact/hooks";
import type {
  AuthAction,
  AuthConfig,
  AuthStage,
  RegistrationForm,
  RegistrationResult,
} from "./types";
import { fetchAuthConfig } from "./api";
import { RegisterScreen } from "./RegisterScreen";
import { RecoveryScreen } from "./RecoveryScreen";

interface Props {
  authStage: AuthStage;
  authConfig: AuthConfig | null;
  registration: RegistrationForm;
  registrationResult: RegistrationResult | null;
  dispatch: (action: AuthAction) => void;
}

export function AuthGate({
  authStage,
  authConfig,
  registration,
  registrationResult,
  dispatch,
}: Props) {
  // On mount: fetch /api/auth/config. The result drives stage
  // transition out of "bootstrapping".
  useEffect(() => {
    if (authStage !== "bootstrapping") return;
    let cancelled = false;
    fetchAuthConfig()
      .then((config) => {
        if (cancelled) return;
        dispatch({ kind: "auth_config_loaded", config });
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("auth config fetch failed:", err);
        dispatch({
          kind: "auth_config_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [authStage, dispatch]);

  if (authStage === "bootstrapping" || !authConfig) {
    return (
      <div class="chalk-auth" data-testid="auth-bootstrapping">
        <div class="chalk-auth-card">
          <p class="chalk-auth-subtitle">connecting...</p>
        </div>
      </div>
    );
  }

  if (authStage === "registering") {
    return (
      <RegisterScreen
        form={registration}
        config={authConfig}
        onFieldChange={(field, value) =>
          dispatch({ kind: "auth_form_change", field, value })
        }
        onSubmitStart={() => dispatch({ kind: "auth_form_submit_start" })}
        onSubmitError={(code, message) =>
          dispatch({ kind: "auth_form_submit_error", code, message })
        }
        onRegistered={(result) => dispatch({ kind: "auth_registered", result })}
      />
    );
  }

  if (authStage === "confirming-recovery") {
    if (!registrationResult) {
      // Shouldn't happen but render a fallback rather than crashing.
      return (
        <div class="chalk-auth" data-testid="auth-recovery-missing">
          <div class="chalk-auth-card">
            <p class="chalk-auth-error">
              Recovery state missing. Please refresh and re-register.
            </p>
          </div>
        </div>
      );
    }
    return (
      <RecoveryScreen
        result={registrationResult}
        onConfirmed={() => dispatch({ kind: "auth_recovery_confirmed" })}
      />
    );
  }

  if (authStage === "transitional-handoff") {
    return (
      <div class="chalk-auth" data-testid="auth-handoff">
        <div class="chalk-auth-card">
          <header class="chalk-auth-header">
            <h2>you're registered</h2>
            <p class="chalk-auth-subtitle">
              {registrationResult ? (
                <>welcome, <strong>@{registrationResult.username}</strong>!</>
              ) : (
                <>welcome!</>
              )}
            </p>
          </header>
          <div class="chalk-auth-warning" data-testid="handoff-notice">
            <strong>note:</strong> sessions land in sub-step 09b-5. Until
            then, chat still uses the legacy test-user path (you'll appear
            as the demo user in the chat UI, not as your real account).
            Your real registration is in the database and will become
            usable once 09b-5 ships.
          </div>
          <button
            type="button"
            class="chalk-button chalk-button--primary"
            onClick={() => dispatch({ kind: "auth_handoff_continue" })}
            data-testid="handoff-continue"
          >
            continue to chat (legacy path)
          </button>
        </div>
      </div>
    );
  }

  // authStage === "authed" should not reach AuthGate; App handles it.
  return null;
}

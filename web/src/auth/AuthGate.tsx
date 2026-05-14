// AuthGate: branch on authStage and render the right pre-chat screen.
//
// Phase 09b sub-step 5b: bootstrap fetches /api/auth/me. The response
// decides whether the user is already authed or needs to log in.
//
// Stages handled here:
//   - bootstrapping       → /me fetch + loading spinner
//   - login               → <LoginScreen>
//   - registering         → <RegisterScreen>
//   - confirming-recovery → <RecoveryScreen>
//   - authed              → not handled here (App renders chat directly)
//
// AuthConfig (which RegisterScreen needs for the dev/open badges)
// is lazy-fetched inside RegisterScreen on its first mount, not here.
// Keeping the bootstrap path lean means /me is the only call on the
// happy path of "user already logged in".

import { useEffect } from "preact/hooks";
import type {
  AuthAction,
  AuthConfig,
  AuthStage,
  LoginForm,
  LoginResult,
  RegistrationForm,
  RegistrationResult,
} from "./types";
import { fetchAuthConfig, fetchMe, ApiError } from "./api";
import { LoginScreen } from "./LoginScreen";
import { RegisterScreen } from "./RegisterScreen";
import { RecoveryScreen } from "./RecoveryScreen";

interface Props {
  authStage: AuthStage;
  authConfig: AuthConfig | null;
  registration: RegistrationForm;
  registrationResult: RegistrationResult | null;
  login: LoginForm;
  dispatch: (action: AuthAction) => void;
}

export function AuthGate({
  authStage,
  authConfig,
  registration,
  registrationResult,
  login,
  dispatch,
}: Props) {
  // On mount: fetch /api/auth/me. 200 → authed (skip the screens
  // entirely), 401 → login (default), network error → surface via
  // auth_config_failed (reuses the existing error slot in the
  // registration form; not ideal but covers the rare case where the
  // server is unreachable at boot).
  useEffect(() => {
    if (authStage !== "bootstrapping") return;
    let cancelled = false;
    fetchMe()
      .then((me) => {
        if (cancelled) return;
        if (me) {
          dispatch({ kind: "auth_me_loaded", me });
        } else {
          dispatch({ kind: "auth_me_absent" });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        // ApiError with code 'network_failure' is the expected
        // server-unreachable case. Other errors get logged.
        console.error("auth bootstrap /me failed:", err);
        const message = err instanceof ApiError ? err.message :
          err instanceof Error ? err.message : String(err);
        dispatch({ kind: "auth_config_failed", message });
        // Also flip to login so the user has somewhere to go (the
        // error banner will surface inside RegisterScreen if they
        // navigate there). Better than being stuck on a spinner.
        dispatch({ kind: "auth_me_absent" });
      });
    return () => {
      cancelled = true;
    };
  }, [authStage, dispatch]);

  // Lazy-fetch /api/auth/config when we enter the registering stage
  // and don't already have the config. Also fetch when on LoginScreen
  // so the register-link can be shown/hidden based on open_registration.
  useEffect(() => {
    if (authConfig) return;
    if (authStage !== "registering" && authStage !== "login") return;
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
  }, [authStage, authConfig, dispatch]);

  if (authStage === "bootstrapping") {
    return (
      <div class="chalk-auth" data-testid="auth-bootstrapping">
        <div class="chalk-auth-card">
          <p class="chalk-auth-subtitle">connecting...</p>
        </div>
      </div>
    );
  }

  if (authStage === "login") {
    return (
      <LoginScreen
        form={login}
        // Show the register link based on the lazily-fetched
        // authConfig. Defaults to true if config hasn't loaded yet
        // (the user will see the link; clicking it triggers
        // RegisterScreen's own config fetch).
        showRegisterLink={authConfig ? authConfig.open_registration : true}
        onFieldChange={(field, value) =>
          dispatch({ kind: "auth_login_form_change", field, value })
        }
        onSubmitStart={() => dispatch({ kind: "auth_login_submit_start" })}
        onSubmitError={(code, message) =>
          dispatch({ kind: "auth_login_submit_error", code, message })
        }
        onLoggedIn={(result: LoginResult) =>
          dispatch({ kind: "auth_logged_in", result })
        }
        onGoRegister={() => dispatch({ kind: "auth_go_register" })}
      />
    );
  }

  if (authStage === "registering") {
    if (!authConfig) {
      // Config not yet loaded. RegisterScreen will trigger the fetch
      // itself on mount. Render a brief placeholder so we don't flash
      // an empty card.
      return (
        <div class="chalk-auth" data-testid="auth-registering-bootstrapping">
          <div class="chalk-auth-card">
            <p class="chalk-auth-subtitle">loading registration form...</p>
          </div>
        </div>
      );
    }
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
        onGoLogin={() => dispatch({ kind: "auth_go_login" })}
      />
    );
  }

  if (authStage === "confirming-recovery") {
    if (!registrationResult) {
      return (
        <div class="chalk-auth" data-testid="auth-recovery-missing">
          <div class="chalk-auth-card">
            <p class="chalk-auth-error">
              Recovery state missing. Please refresh and log in.
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

  // authStage === "authed" should not reach AuthGate; App handles it.
  return null;
}

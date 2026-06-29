// AuthGate: branch on authStage and render the right pre-chat screen.
//
// Phase 09b sub-step 5b: bootstrap fetches /api/auth/me.
// Phase 09b sub-step 6: added recovery-login and regenerate-after-
// recovery stages.
//
// Stages handled here:
//   - bootstrapping              → /me fetch + loading spinner
//   - login                      → <LoginScreen>
//   - registering                → <RegisterScreen>
//   - confirming-recovery        → <RecoveryScreen intent="registered">
//   - recovery-login             → <RecoveryLoginScreen>
//   - regenerate-after-recovery  → <RegenerateScreen> (auto-fetches
//                                  new words, then renders inner
//                                  RecoveryScreen intent="regenerated")
//   - authed                     → not handled here (App renders chat)
//
// AuthConfig (which RegisterScreen needs for the dev/open badges)
// is lazy-fetched inside AuthGate when entering login or registering.

import { useEffect } from "preact/hooks";
import type {
  AdminBootstrapState,
  AuthAction,
  AuthConfig,
  AuthStage,
  InviteContext,
  LoginForm,
  LoginResult,
  MeResponse,
  RecoveryLoginForm,
  RecoveryLoginResult,
  RegistrationForm,
  RegistrationResult,
  VerifyEmailChangeState,
} from "./types";
import { fetchAuthConfig, fetchMe, ApiError } from "./api";
import { LoginScreen } from "./LoginScreen";
import { RegisterScreen } from "./RegisterScreen";
import { RecoveryScreen } from "./RecoveryScreen";
import { RecoveryLoginScreen } from "./RecoveryLoginScreen";
import { RegenerateScreen } from "./RegenerateScreen";
import { AddPasskeyAfterRecoveryScreen } from "./AddPasskeyAfterRecoveryScreen";
import { RegisterFromInviteScreen } from "./RegisterFromInviteScreen";
import { VerifyEmailChangeScreen } from "./VerifyEmailChangeScreen";
import { AdminBootstrapScreen } from "./AdminBootstrapScreen";

interface Props {
  authStage: AuthStage;
  authConfig: AuthConfig | null;
  registration: RegistrationForm;
  registrationResult: RegistrationResult | null;
  login: LoginForm;
  // Phase 09b sub-step 6 additions:
  recoveryLogin: RecoveryLoginForm;
  pendingRegenerateWords: string[] | null;
  me: MeResponse | null;
  // Phase 09c-2 additions:
  inviteContext: InviteContext | null;
  verifyEmailChange: VerifyEmailChangeState | null;
  // Phase 09d-2a:
  adminBootstrap: AdminBootstrapState | null;
  dispatch: (action: AuthAction) => void;
}

export function AuthGate({
  authStage,
  authConfig,
  registration,
  registrationResult,
  login,
  recoveryLogin,
  pendingRegenerateWords,
  me,
  inviteContext,
  verifyEmailChange,
  adminBootstrap,
  dispatch,
}: Props) {
  // On mount: bootstrap. Phase 09c-2 adds two URL-driven branches
  // ahead of the /me fetch:
  //
  //   - ?invite=<token>        → registering-from-invite stage
  //   - ?verify_email=<token>  → verifying-email-change stage
  //
  // URL params take precedence over session state. Reason: someone
  // clicking an invite link in their email expects to land on the
  // "you've been invited" screen, not on a chat session belonging
  // to whoever was logged in last in this browser. Similarly for
  // verify links.
  //
  // If neither param is present, fall through to /me fetch (200 →
  // authed, 401 → login).
  useEffect(() => {
    if (authStage !== "bootstrapping") return;

    // Parse URL params. Use the global location; the SPA doesn't
    // route to subpaths, but the params can appear on any path.
    const params = new URLSearchParams(window.location.search);
    const inviteToken = params.get("invite");
    const verifyEmailToken = params.get("verify_email");
    const adminBootstrapToken = params.get("admin_bootstrap");

    if (inviteToken) {
      // Clean the URL so a refresh doesn't re-fire the flow. Keep
      // the path; drop the query. (history.replaceState; we don't
      // need a SPA router.)
      window.history.replaceState({}, "", window.location.pathname);
      dispatch({ kind: "auth_invite_detected", token: inviteToken });
      return;
    }
    if (verifyEmailToken) {
      window.history.replaceState({}, "", window.location.pathname);
      dispatch({ kind: "auth_verify_email_detected", token: verifyEmailToken });
      return;
    }
    if (adminBootstrapToken) {
      // Phase 09d-2a: first-run admin enrollment.
      //
      // Phase 9.5 (B7): before showing the bootstrap screen, probe
      // /me. If we're already authed, the token would just be
      // rejected with admin_already_enrolled, which is a confusing
      // UX — drop the token and continue as the existing session.
      // If we're not authed, fire the bootstrap flow as before.
      window.history.replaceState({}, "", window.location.pathname);
      let cancelled = false;
      fetchMe()
        .then((me) => {
          if (cancelled) return;
          if (me) {
            // Already authed — skip the bootstrap card.
            dispatch({ kind: "auth_me_loaded", me });
          } else {
            dispatch({
              kind: "auth_admin_bootstrap_detected",
              token: adminBootstrapToken,
            });
          }
        })
        .catch(() => {
          if (cancelled) return;
          // /me threw — fall through to bootstrap; the server's
          // begin call will sort out the real state.
          dispatch({
            kind: "auth_admin_bootstrap_detected",
            token: adminBootstrapToken,
          });
        });
      return () => {
        cancelled = true;
      };
    }

    // No URL-driven flow → /me fetch as before.
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
        console.error("auth bootstrap /me failed:", err);
        const message = err instanceof ApiError ? err.message :
          err instanceof Error ? err.message : String(err);
        dispatch({ kind: "auth_config_failed", message });
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
        onGoRecovery={() => dispatch({ kind: "auth_go_recovery" })}
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
        username={registrationResult.username}
        userID={registrationResult.userID}
        recoveryWords={registrationResult.recoveryWords}
        intent="registered"
        onConfirmed={() => dispatch({ kind: "auth_recovery_confirmed" })}
      />
    );
  }

  if (authStage === "recovery-login") {
    return (
      <RecoveryLoginScreen
        form={recoveryLogin}
        onFieldChange={(field, value) =>
          dispatch({ kind: "auth_recovery_login_form_change", field, value })
        }
        onSubmitStart={() => dispatch({ kind: "auth_recovery_login_submit_start" })}
        onSubmitError={(code, message) =>
          dispatch({ kind: "auth_recovery_login_submit_error", code, message })
        }
        onRecovered={(result: RecoveryLoginResult) =>
          dispatch({ kind: "auth_recovered", result })
        }
        onGoLogin={() => dispatch({ kind: "auth_go_login" })}
      />
    );
  }

  if (authStage === "regenerate-after-recovery") {
    if (!me) {
      // Shouldn't happen: auth_recovered always populates me before
      // flipping to this stage. Defensive fallback.
      return (
        <div class="chalk-auth" data-testid="auth-regenerate-missing">
          <div class="chalk-auth-card">
            <p class="chalk-auth-error">
              Identity missing. Please refresh and log in.
            </p>
          </div>
        </div>
      );
    }
    return (
      <RegenerateScreen
        me={me}
        pendingWords={pendingRegenerateWords}
        onWordsLoaded={(words) =>
          dispatch({ kind: "auth_regenerate_words_loaded", words })
        }
        onConfirmed={() => dispatch({ kind: "auth_regenerate_confirmed" })}
      />
    );
  }

  if (authStage === "offer-passkey-after-recovery") {
    // md-6: after a recovery login the user has a session but no passkey
    // on this device. Offer to enroll one before entering the chat;
    // skippable.
    return (
      <AddPasskeyAfterRecoveryScreen
        onDone={() => dispatch({ kind: "auth_passkey_offer_done" })}
      />
    );
  }

  // ---- Phase 09c-2: URL-driven flows ----------------------------------

  if (authStage === "registering-from-invite") {
    if (!inviteContext) {
      // Defensive: the reducer always populates inviteContext when
      // entering this stage; this branch shouldn't fire.
      return (
        <div class="chalk-auth" data-testid="auth-invite-missing">
          <div class="chalk-auth-card">
            <p class="chalk-auth-error">
              Invite context missing. Please refresh.
            </p>
          </div>
        </div>
      );
    }
    return (
      <RegisterFromInviteScreen
        inviteContext={inviteContext}
        form={registration}
        config={authConfig}
        onPeekLoaded={(peek, status) =>
          dispatch({ kind: "auth_invite_peek_loaded", peek, status })
        }
        onPeekFailed={(code, message) =>
          dispatch({ kind: "auth_invite_peek_failed", code, message })
        }
        onFieldChange={(field, value) =>
          dispatch({ kind: "auth_form_change", field, value })
        }
        onSubmitStart={() => dispatch({ kind: "auth_form_submit_start" })}
        onSubmitError={(code, message) =>
          dispatch({ kind: "auth_form_submit_error", code, message })
        }
        onRegistered={(result) => dispatch({ kind: "auth_registered", result })}
        onDismiss={() => dispatch({ kind: "auth_invite_dismissed" })}
      />
    );
  }

  if (authStage === "verifying-email-change") {
    if (!verifyEmailChange) {
      return (
        <div class="chalk-auth" data-testid="auth-verify-missing">
          <div class="chalk-auth-card">
            <p class="chalk-auth-error">
              Verification context missing. Please refresh.
            </p>
          </div>
        </div>
      );
    }
    return (
      <VerifyEmailChangeScreen
        verify={verifyEmailChange}
        hasSession={me !== null}
        onSucceeded={(userID, newEmail) =>
          dispatch({ kind: "auth_verify_email_succeeded", userID, newEmail })
        }
        onFailed={(code, message) =>
          dispatch({ kind: "auth_verify_email_failed", code, message })
        }
        onDismiss={() => dispatch({ kind: "auth_verify_email_dismissed" })}
      />
    );
  }

  // ---- Phase 09d-2a: admin bootstrap stage --------------------------

  if (authStage === "admin-bootstrap") {
    if (!adminBootstrap) {
      // Defensive: the reducer always populates adminBootstrap on
      // entry to this stage. If somehow missing, fall back to login.
      return (
        <div class="chalk-auth" data-testid="auth-admin-bootstrap-missing">
          <div class="chalk-auth-card">
            <p class="chalk-auth-error">
              Admin bootstrap state missing. Please refresh.
            </p>
          </div>
        </div>
      );
    }
    return (
      <AdminBootstrapScreen
        token={adminBootstrap.token}
        busy={adminBootstrap.busy}
        errorCode={adminBootstrap.errorCode}
        errorMessage={adminBootstrap.errorMessage}
        onSubmitStart={() => dispatch({ kind: "auth_admin_bootstrap_submit_start" })}
        onSubmitError={(code, message) =>
          dispatch({ kind: "auth_admin_bootstrap_submit_error", code, message })
        }
        onBootstrapped={(result) =>
          dispatch({ kind: "auth_registered", result })
        }
        onDismiss={() => dispatch({ kind: "auth_admin_bootstrap_dismissed" })}
      />
    );
  }

  // authStage === "authed" should not reach AuthGate; App handles it.
  return null;
}

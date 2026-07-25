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
//   - recovery-login             → <RecoveryResetScreen> (31-13: the
//                                  recovery phrase resets the password
//                                  and TOTP rather than merely signing
//                                  in; it shows the fresh words itself,
//                                  so the old regenerate stage is gone)
//   - authed                     → not handled here (App renders chat)
//
// AuthConfig (which RegisterScreen needs for the dev/open badges)
// is lazy-fetched inside AuthGate when entering login or registering.

import { useEffect } from "preact/hooks";
import type {
  AuthAction,
  AuthConfig,
  AuthStage,
  InviteContext,
  LoginForm,
  LoginResult,
  MeResponse,
  RegistrationForm,
  RegistrationResult,
  VerifyEmailChangeState,
} from "./types";
import { fetchAuthConfig, fetchMe, ApiError } from "./api";
import { probeAdminClaim } from "./signup-v2-api";
// 31-7: LoginScreen (passkey-only) is embedded inside the password login
// as a fallback mode; the gate renders the password-first screen.
import { PasswordLoginScreen } from "./PasswordLoginScreen";
// 31-6b: RegisterScreen (passkey-first) is superseded by the wizard; the
// file remains for reference but is no longer imported.
import { SignupWizardScreen } from "./SignupWizardScreen";
import { RecoveryScreen } from "./RecoveryScreen";
import { RecoveryResetScreen } from "./RecoveryResetScreen";
import { AddPasskeyAfterRecoveryScreen } from "./AddPasskeyAfterRecoveryScreen";
import { RegisterFromInviteScreen } from "./RegisterFromInviteScreen";
import { VerifyEmailChangeScreen } from "./VerifyEmailChangeScreen";

interface Props {
  authStage: AuthStage;
  authConfig: AuthConfig | null;
  registration: RegistrationForm;
  registrationResult: RegistrationResult | null;
  login: LoginForm;
  me: MeResponse | null;
  // Phase 09c-2 additions:
  inviteContext: InviteContext | null;
  verifyEmailChange: VerifyEmailChangeState | null;
  // 31-11: non-null while claiming the admin account from an
  // /?admin_token= enrollment URL; fixes the wizard's username.
  adminClaimUsername: string | null;
  dispatch: (action: AuthAction) => void;
}

export function AuthGate({
  authStage,
  authConfig,
  registration,
  registrationResult,
  login,
  me,
  inviteContext,
  verifyEmailChange,
  adminClaimUsername,
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
    const adminToken = params.get("admin_token");

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
    if (adminToken) {
      // 31-11: first-run admin enrollment. chalkctl prints this URL.
      //
      // Note what is NOT here: the replaceState that the branches
      // above use to scrub the query. signupV2Begin re-reads
      // admin_token from window.location.search when it POSTs, so
      // scrubbing it now would strip the wizard's authorization
      // before it is used. The param goes away with the rest of the
      // signup, once the account exists.
      //
      // Probe first. An already-authed visitor, a spent token, or a
      // typo should all continue to the ordinary flow rather than
      // land on a wizard that cannot succeed.
      let cancelled = false;
      fetchMe()
        .then((me) => {
          if (cancelled) return null;
          if (me) {
            dispatch({ kind: "auth_me_loaded", me });
            return null;
          }
          return probeAdminClaim(adminToken);
        })
        .then((probe) => {
          if (cancelled || !probe) return;
          if (probe.claimable && probe.username) {
            dispatch({
              kind: "auth_admin_claim_detected",
              username: probe.username,
            });
          } else {
            dispatch({ kind: "auth_me_absent" });
          }
        })
        .catch(() => {
          if (cancelled) return;
          // Probe failed (server unreachable, malformed response).
          // The login screen is the honest fallback.
          dispatch({ kind: "auth_me_absent" });
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
    // 31-7: password+TOTP login (passkey available as an embedded mode).
    return (
      <PasswordLoginScreen
        showRegisterLink={authConfig ? authConfig.open_registration : true}
        onLoggedIn={(result: LoginResult) =>
          dispatch({ kind: "auth_logged_in", result })
        }
        onGoRegister={() => dispatch({ kind: "auth_go_register" })}
        onGoRecovery={(username) => dispatch({ kind: "auth_go_recovery", username })}
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
    // 31-6b: password+TOTP-first wizard replaces the passkey-first
    // RegisterScreen. The passkey becomes an optional later addition.
    return (
      <SignupWizardScreen
        config={authConfig}
        initialInviteToken={registration.inviteToken || undefined}
        adminClaimUsername={adminClaimUsername || undefined}
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
      <RecoveryResetScreen
        initialUsername={login.username}
        onDone={(me) => dispatch({ kind: "auth_recovery_reset_done", me })}
        // The reset itself succeeded but /me didn't answer. The new password
        // works; sending them to sign-in is honest and recoverable.
        onFailedAfterReset={() => dispatch({ kind: "auth_me_absent" })}
        onGoLogin={() => dispatch({ kind: "auth_go_login" })}
      />
    );
  }

  if (authStage === "offer-passkey-after-recovery") {
    // md-6: after a recovery reset the user has a session but no passkey
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

  // authStage === "authed" should not reach AuthGate; App handles it.
  return null;
}

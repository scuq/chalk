// VerifyEmailChangeScreen: pre-chat screen for the verify-email-change
// click-through flow. Phase 09c-2.
//
// Activated when the SPA boots with ?verify_email=<token> in the URL.
// AuthGate detects the param, dispatches auth_verify_email_detected,
// flips authStage to "verifying-email-change", and renders this
// screen. The screen fires POST /api/auth/verify-email-change/{token}
// on mount, then transitions through:
//
//   loading  → small "verifying..." card
//   success  → "your email is now X" card, "continue" button
//   failure  → "verification failed" card with the error message,
//              "go to login" or "back to chat" escape depending on
//              session presence
//
// The flow is session-OPTIONAL: a user whose session expired between
// clicking "change email" and clicking the verification link must
// still be able to complete the change. The server enforces this:
// the token alone authorizes the verify call, the SPA doesn't need
// a cookie. Once verify succeeds, the SPA returns either to login
// (if no session) or to chat (if a session was active in this tab).

import { useEffect } from "preact/hooks";
import type { VerifyEmailChangeState } from "./types";
import { verifyEmailChange, ApiError } from "./api";

interface Props {
  verify: VerifyEmailChangeState;
  // hasSession is true when state.me is set in the surrounding tab,
  // i.e. the user is already logged in here. Controls the post-success
  // CTA: "back to chat" vs "go to login".
  hasSession: boolean;
  onSucceeded: (userID: string, newEmail: string) => void;
  onFailed: (code: string, message: string) => void;
  onDismiss: () => void;
}

export function VerifyEmailChangeScreen({
  verify,
  hasSession,
  onSucceeded,
  onFailed,
  onDismiss,
}: Props) {
  useEffect(() => {
    if (verify.phase !== "loading") return;
    let cancelled = false;
    verifyEmailChange(verify.token)
      .then((result) => {
        if (cancelled) return;
        onSucceeded(result.user_id, result.email);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          onFailed(err.code, err.message);
          return;
        }
        console.error("verify-email-change failed:", err);
        onFailed("unknown",
          err instanceof Error ? err.message : "could not verify email change");
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [verify.phase, verify.token]);

  if (verify.phase === "loading") {
    return (
      <div class="chalk-auth" data-testid="verify-email-loading">
        <div class="chalk-auth-card">
          <header class="chalk-auth-header">
            <h2>verifying email change...</h2>
          </header>
          <p class="chalk-auth-subtitle">just a moment.</p>
        </div>
      </div>
    );
  }

  if (verify.phase === "success") {
    return (
      <div class="chalk-auth" data-testid="verify-email-success">
        <div class="chalk-auth-card">
          <header class="chalk-auth-header">
            <h2>email updated</h2>
            <p class="chalk-auth-subtitle">
              your account's email is now <strong>{verify.newEmail}</strong>.
            </p>
          </header>
          <button
            type="button"
            class="chalk-button chalk-button--primary"
            onClick={onDismiss}
            data-testid="verify-email-success-continue"
          >
            {hasSession ? "back to chat" : "go to login"}
          </button>
        </div>
      </div>
    );
  }

  // failure
  const friendlyMessage = friendlyVerifyError(verify.errorCode, verify.errorMessage);
  return (
    <div class="chalk-auth" data-testid="verify-email-failure">
      <div class="chalk-auth-card">
        <header class="chalk-auth-header">
          <h2>could not verify email change</h2>
        </header>
        <div class="chalk-auth-error">{friendlyMessage}</div>
        <button
          type="button"
          class="chalk-button chalk-button--primary"
          onClick={onDismiss}
          data-testid="verify-email-failure-continue"
        >
          {hasSession ? "back to chat" : "go to login"}
        </button>
      </div>
    </div>
  );
}

function friendlyVerifyError(code: string, message: string): string {
  switch (code) {
    case "invite_invalid_shape":
      return "the verification token in the URL is malformed. you may have copied it incompletely.";
    case "verify_failed":
      return "the verification link is invalid, expired, or has already been used. start the email-change flow again from your profile if you still want to change your email.";
    case "email_taken":
      return "another account claimed that email between your request and now. start the email-change flow again from your profile with a different address.";
    default:
      return message || "verification failed for an unexpected reason; see browser console.";
  }
}

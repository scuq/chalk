// RegisterFromInviteScreen: registration form pre-filled from an
// invite URL. Phase 09c-2.
//
// Activated when the SPA boots with ?invite=<token> in the URL.
// AuthGate detects the param, dispatches auth_invite_detected,
// flips authStage to "registering-from-invite", and renders this
// screen. The screen fires the peek call on mount (via AuthGate's
// effect or this screen's own useEffect, depending on flow), then
// renders one of four shapes based on inviteContext.peekStatus:
//
//   loading            → small spinner card
//   active             → the actual registration form, with email
//                         pre-filled (read-only) and the inviter's
//                         username shown as context
//   used/revoked/expired → "this invite has been X" card, no form,
//                          with a "register normally" or "log in"
//                          escape link
//   error              → "couldn't load invite: X" card with the
//                          same escapes
//
// On submit (active path):
//   1. Call /api/auth/register/begin with invite_token + email
//   2. Call navigator.credentials.create()
//   3. Call /api/auth/register/finish
//   4. Dispatch auth_registered → confirming-recovery (same as
//      RegisterScreen)
//
// Why a separate screen rather than reusing RegisterScreen with a
// pre-filled form: the UX differs significantly. Invite-driven users
// see "you've been invited by @scuq" framing, a locked email, and
// shouldn't be allowed to change either. The peek-error UX has no
// equivalent in the open registration path. Keeping them separate
// avoids RegisterScreen accumulating branches.

import { useEffect } from "preact/hooks";
import type {
  AuthConfig,
  InviteContext,
  RegistrationForm,
  RegistrationResult,
} from "./types";
import { peekInvite, registerBegin, registerFinish, ApiError } from "./api";
import { performRegistration, WebAuthnError } from "../webauthn";

interface Props {
  inviteContext: InviteContext;
  form: RegistrationForm;
  config: AuthConfig | null; // for the dev/open badges
  onPeekLoaded: (peek: { email: string; inviterUsername: string; expiresAt: string }, status: "active" | "used" | "revoked" | "expired") => void;
  onPeekFailed: (code: string, message: string) => void;
  onFieldChange: (field: keyof RegistrationForm, value: string | boolean) => void;
  onSubmitStart: () => void;
  onSubmitError: (code: string, message: string) => void;
  onRegistered: (result: RegistrationResult) => void;
  onDismiss: () => void;
}

const USER_FACING_REGISTER_ERROR_CODES = new Set([
  "bad_username",
  "username_reserved",
  "username_taken",
  "bad_email",
  "email_taken",
  "invite_email_mismatch",
  "invite_used",
  "invite_revoked",
  "invite_expired",
  "invite_not_found",
  "email_blacklisted",
]);

export function RegisterFromInviteScreen({
  inviteContext,
  form,
  config,
  onPeekLoaded,
  onPeekFailed,
  onFieldChange,
  onSubmitStart,
  onSubmitError,
  onRegistered,
  onDismiss,
}: Props) {
  // Fire the peek exactly once, on mount, while peekStatus is
  // "loading". The reducer guarantees peekStatus starts at "loading"
  // when this stage is entered; if a re-render happens with a
  // different status, we don't re-fetch.
  useEffect(() => {
    if (inviteContext.peekStatus !== "loading") return;
    let cancelled = false;
    peekInvite(inviteContext.token)
      .then((result) => {
        if (cancelled) return;
        onPeekLoaded(
          {
            email: result.email,
            inviterUsername: result.inviter_username,
            expiresAt: result.expires_at,
          },
          result.status,
        );
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError) {
          onPeekFailed(err.code, err.message);
          return;
        }
        console.error("invite peek failed:", err);
        onPeekFailed("unknown",
          err instanceof Error ? err.message : "could not load invite");
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteContext.peekStatus, inviteContext.token]);

  // ---- loading ----------------------------------------------------------

  if (inviteContext.peekStatus === "loading") {
    return (
      <div class="chalk-auth" data-testid="register-from-invite-loading">
        <div class="chalk-auth-card">
          <p class="chalk-auth-subtitle">loading invite...</p>
        </div>
      </div>
    );
  }

  // ---- error / inactive states -----------------------------------------

  if (inviteContext.peekStatus === "error") {
    return (
      <div class="chalk-auth" data-testid="register-from-invite-error">
        <div class="chalk-auth-card">
          <header class="chalk-auth-header">
            <h2>invite couldn't be loaded</h2>
          </header>
          <div class="chalk-auth-error">
            {inviteContext.errorMessage || "the invite token in the URL is invalid or could not be retrieved."}
          </div>
          <div class="chalk-auth-alt">
            <button
              type="button"
              class="chalk-auth-link"
              onClick={onDismiss}
              data-testid="register-from-invite-dismiss"
            >
              go to login
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (inviteContext.peekStatus !== "active") {
    // used / revoked / expired
    const heading =
      inviteContext.peekStatus === "used"     ? "this invite has already been used"  :
      inviteContext.peekStatus === "revoked"  ? "this invite was revoked"            :
                                                "this invite has expired";
    const subtitle =
      inviteContext.peekStatus === "used"
        ? "the person who held this link has already created their account."
        : inviteContext.peekStatus === "revoked"
          ? "the sender pulled this invite back. ask them to issue a new one."
          : "the time window for this invite has passed. ask the sender to issue a new one.";
    return (
      <div class="chalk-auth" data-testid={`register-from-invite-${inviteContext.peekStatus}`}>
        <div class="chalk-auth-card">
          <header class="chalk-auth-header">
            <h2>{heading}</h2>
            <p class="chalk-auth-subtitle">{subtitle}</p>
          </header>
          {inviteContext.peek && (
            <div class="chalk-auth-warning">
              issued to <strong>{inviteContext.peek.email}</strong>
              {inviteContext.peek.inviterUsername && (
                <> by <strong>@{inviteContext.peek.inviterUsername}</strong></>
              )}
            </div>
          )}
          <div class="chalk-auth-alt">
            <button
              type="button"
              class="chalk-auth-link"
              onClick={onDismiss}
              data-testid="register-from-invite-dismiss"
            >
              go to login
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- active: render the actual form ---------------------------------

  const peek = inviteContext.peek!;
  const fieldError = form.errorCode && USER_FACING_REGISTER_ERROR_CODES.has(form.errorCode)
    ? form.errorCode
    : null;
  const bannerError = form.errorCode && form.errorMessage && !fieldError
    ? form.errorMessage
    : null;

  const onSubmit = async (e: Event) => {
    e.preventDefault();
    if (form.busy) return;
    onSubmitStart();
    try {
      const opts = await registerBegin({
        username: form.username.trim().toLowerCase(),
        display_name: form.displayName.trim() || undefined,
        email: peek.email, // locked to the invite's address
        invite_token: inviteContext.token,
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
        const map: Record<string, string> = {
          not_supported:
            "your browser doesn't support WebAuthn, or this page isn't served over HTTPS.",
          user_cancelled:
            "you cancelled the registration. click register to try again.",
          constraint:
            "your authenticator doesn't meet the requirements.",
          security:
            "security check failed. make sure you're on the right domain.",
        };
        onSubmitError(`webauthn_${err.kind}`, map[err.kind] ?? "registration failed; see browser console.");
        return;
      }
      console.error("register-from-invite: unexpected error:", err);
      onSubmitError("unexpected", "registration failed unexpectedly; see browser console.");
    }
  };

  return (
    <div class="chalk-auth" data-testid="register-from-invite-screen">
      <div class="chalk-auth-card">
        <header class="chalk-auth-header">
          <h2>you've been invited</h2>
          <p class="chalk-auth-subtitle">
            <strong>@{peek.inviterUsername}</strong> invited{" "}
            <strong>{peek.email}</strong> to chalk
          </p>
          <p class="chalk-auth-subtitle">
            invite expires {formatExpiry(peek.expiresAt)}
          </p>
        </header>

        {bannerError && (
          <div class="chalk-auth-error" data-testid="register-from-invite-error-banner">
            {bannerError}
          </div>
        )}

        <form class="chalk-auth-form" onSubmit={onSubmit}>
          <div class="chalk-field">
            <label class="chalk-field-label" for="rfi-username">username</label>
            <input
              id="rfi-username"
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
              data-testid="rfi-username"
              autoFocus
            />
            <span class="chalk-field-hint">
              3–32 chars; lowercase letters, digits, underscore
            </span>
            {fieldError && (fieldError === "bad_username" || fieldError === "username_reserved" || fieldError === "username_taken") && (
              <span class="chalk-field-error">{form.errorMessage}</span>
            )}
          </div>

          <div class="chalk-field">
            <label class="chalk-field-label" for="rfi-display-name">
              display name <span class="chalk-field-optional">(optional)</span>
            </label>
            <input
              id="rfi-display-name"
              class="chalk-field-input"
              type="text"
              autoComplete="name"
              maxLength={80}
              value={form.displayName}
              disabled={form.busy}
              onInput={(e) => onFieldChange("displayName", (e.target as HTMLInputElement).value)}
              data-testid="rfi-display-name"
            />
            <span class="chalk-field-hint">
              what others see; defaults to your username
            </span>
          </div>

          <div class="chalk-field">
            <label class="chalk-field-label" for="rfi-email">email</label>
            <input
              id="rfi-email"
              class="chalk-field-input"
              type="email"
              autoComplete="email"
              value={peek.email}
              readOnly
              disabled
              data-testid="rfi-email"
            />
            <span class="chalk-field-hint">
              locked to the invite; cannot be changed
            </span>
          </div>

          <button
            type="submit"
            class="chalk-button chalk-button--primary"
            disabled={form.busy}
            data-testid="rfi-submit"
          >
            {form.busy ? "registering..." : "accept invite & register"}
          </button>

          {config && (
            <div class="chalk-auth-meta">
              <span>RP: {config.rp_name}</span>
              {config.dev_mode && <span class="chalk-auth-meta-dev">DEV</span>}
            </div>
          )}
        </form>

        <div class="chalk-auth-alt">
          not the right account?{" "}
          <button
            type="button"
            class="chalk-auth-link"
            onClick={onDismiss}
            disabled={form.busy}
            data-testid="rfi-dismiss"
          >
            go to login
          </button>
        </div>
      </div>
    </div>
  );
}

// formatExpiry renders an ISO timestamp as a short relative-ish
// display (e.g. "Mon Jan 20, 2:15 PM"). Falls back to the raw string
// if parsing fails.
function formatExpiry(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, {
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

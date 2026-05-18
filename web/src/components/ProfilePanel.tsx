// ProfilePanel: in-chat modal for managing the user's own profile.
// Phase 09c-2.
//
// Three sections:
//
//   1. Identity (read-only): username, display name, email,
//      session expiry.
//
//   2. Change email: form for starting the email-change flow.
//      On submit, the server sends a verify link to the new
//      address and a notification to the old. The user must click
//      the link in the new inbox to finalize. After submit, this
//      panel shows a "verification email sent" summary until
//      dismissed or the panel is closed.
//
//   3. Rotate recovery code: button that calls /api/auth/recovery/
//      regenerate, displays the new 24-word phrase in a confirm-
//      and-continue gate (RecoveryScreen intent="regenerated").
//      A user might do this if they suspect their old phrase
//      was compromised, or just for periodic hygiene.
//
// All three live in the same modal. Section 3 is heavy enough that
// when active it takes over the modal body (the identity + change-
// email sections fade out, the recovery view fades in). A back
// button returns to the main panel without rotating, in case the
// user clicked it by accident.

import { useEffect, useState } from "preact/hooks";
import type { EmailChangeState, MeResponse } from "../auth/types";
import { regenerateRecovery, ApiError } from "../auth/api";
import { RecoveryScreen } from "../auth/RecoveryScreen";

interface Props {
  me: MeResponse;
  emailChange: EmailChangeState;
  onClose: () => void;
  onEmailChangeDraft: (value: string) => void;
  onEmailChangeSubmit: () => void;
  onEmailChangeDismiss: () => void;
  // Refresh re-fetches /api/auth/me so identity fields stay current
  // (e.g. if you verified an email change in another tab). Optional —
  // if the parent doesn't wire it, the refresh button doesn't render.
  onRefresh?: () => void;
  refreshing?: boolean;
}

export function ProfilePanel({
  me,
  emailChange,
  onClose,
  onEmailChangeDraft,
  onEmailChangeSubmit,
  onEmailChangeDismiss,
  onRefresh,
  refreshing,
}: Props) {
  // Local UI state: are we in the rotate-recovery sub-view?
  // Local because no other component cares.
  const [rotateView, setRotateView] = useState<"idle" | "loading" | "showing" | "error">("idle");
  const [rotatedWords, setRotatedWords] = useState<string[] | null>(null);
  const [rotateError, setRotateError] = useState<string>("");

  // Close on Escape (only when not in rotate-showing state; we
  // don't want a stray keypress to lose the new recovery words).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if (rotateView === "showing") return;
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, rotateView]);

  const startRotate = async () => {
    setRotateView("loading");
    setRotateError("");
    try {
      const words = await regenerateRecovery();
      if (words.length !== 24) {
        setRotateView("error");
        setRotateError(`server returned ${words.length} words; expected 24`);
        return;
      }
      setRotatedWords(words);
      setRotateView("showing");
    } catch (e) {
      console.error("rotate recovery failed:", e);
      setRotateView("error");
      setRotateError(e instanceof ApiError
        ? `${e.code}: ${e.message}`
        : e instanceof Error ? e.message : "unknown error");
    }
  };

  const finishRotate = () => {
    setRotatedWords(null);
    setRotateView("idle");
  };

  // ---- rotate-showing view (full-modal takeover) ----------------------

  if (rotateView === "showing" && rotatedWords) {
    return (
      <div class="chalk-modal-backdrop" data-testid="profile-panel-rotate-backdrop">
        <div class="chalk-modal chalk-modal--wide" data-testid="profile-panel-rotate" role="dialog">
          <RecoveryScreen
            username={me.username}
            userID={me.userID}
            recoveryWords={rotatedWords}
            intent="regenerated"
            onConfirmed={finishRotate}
          />
        </div>
      </div>
    );
  }

  // ---- main view -------------------------------------------------------

  const submitEmailDisabled =
    emailChange.busy ||
    !emailChange.draft.trim() ||
    emailChange.draft.trim().toLowerCase() === me.email.toLowerCase();

  const emailBannerError = emailChange.errorCode && emailChange.errorMessage
    ? friendlyEmailChangeError(emailChange.errorCode, emailChange.errorMessage)
    : null;

  return (
    <div
      class="chalk-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="profile-panel-backdrop"
    >
      <div class="chalk-modal" data-testid="profile-panel" role="dialog" aria-label="profile">
        <header class="chalk-modal-header">
          <h2>profile</h2>
          <div class="chalk-modal-header-actions">
            {onRefresh && (
              <button
                type="button"
                class={`chalk-modal-refresh${refreshing ? " chalk-modal-refresh--spinning" : ""}`}
                onClick={onRefresh}
                disabled={refreshing}
                aria-label="refresh"
                title="refresh"
                data-testid="profile-panel-refresh"
              >
                ↻
              </button>
            )}
            <button
              type="button"
              class="chalk-modal-close"
              onClick={onClose}
              aria-label="close"
              data-testid="profile-panel-close"
            >
              ×
            </button>
          </div>
        </header>

        <div class="chalk-modal-body">
          {/* Identity section */}
          <section class="chalk-profile-identity">
            <h3>identity</h3>
            <dl class="chalk-profile-fields">
              <dt>username</dt>
              <dd data-testid="profile-username">@{me.username}</dd>

              <dt>display name</dt>
              <dd>{me.displayName || <em>(none set)</em>}</dd>

              <dt>email</dt>
              <dd data-testid="profile-email">{me.email}</dd>

              <dt>role</dt>
              <dd>{me.role}</dd>

              <dt>session</dt>
              <dd>expires {formatTimestamp(me.sessionExpiresAt)}</dd>
            </dl>
          </section>

          {/* Email change section */}
          <section class="chalk-profile-email-change">
            <h3>change email</h3>
            {emailChange.pendingSummary ? (
              <div class="chalk-profile-pending" data-testid="profile-email-pending">
                <p>
                  we sent a verification email to{" "}
                  <strong>{emailChange.pendingSummary.newEmail}</strong>.
                </p>
                <p class="chalk-auth-subtitle">
                  click the link in that email to complete the change.
                  it expires on {formatTimestamp(emailChange.pendingSummary.expiresAt)}.
                </p>
                <p class="chalk-auth-subtitle">
                  we also notified your current email address as a
                  security heads-up.
                </p>
                <button
                  type="button"
                  class="chalk-button chalk-button--secondary"
                  onClick={onEmailChangeDismiss}
                  data-testid="profile-email-pending-dismiss"
                >
                  ok
                </button>
              </div>
            ) : (
              <form
                class="chalk-auth-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (submitEmailDisabled) return;
                  onEmailChangeSubmit();
                }}
                data-testid="profile-email-form"
              >
                {emailBannerError && (
                  <div class="chalk-auth-error" data-testid="profile-email-error">
                    {emailBannerError}
                  </div>
                )}
                <div class="chalk-field">
                  <label class="chalk-field-label" for="profile-email-new">
                    new email
                  </label>
                  <input
                    id="profile-email-new"
                    class="chalk-field-input"
                    type="email"
                    autoComplete="email"
                    autoCapitalize="none"
                    required
                    value={emailChange.draft}
                    disabled={emailChange.busy}
                    onInput={(e) => onEmailChangeDraft((e.target as HTMLInputElement).value)}
                    data-testid="profile-email-input"
                  />
                  <span class="chalk-field-hint">
                    a verification link will be sent to this address;
                    the change isn't final until you click it
                  </span>
                </div>
                <button
                  type="submit"
                  class="chalk-button chalk-button--primary"
                  disabled={submitEmailDisabled}
                  data-testid="profile-email-submit"
                >
                  {emailChange.busy ? "sending..." : "send verification email"}
                </button>
              </form>
            )}
          </section>

          {/* Rotate recovery section */}
          <section class="chalk-profile-rotate">
            <h3>recovery code</h3>
            <p class="chalk-auth-subtitle">
              if you suspect your recovery phrase has been seen by
              someone else, you can rotate it now. doing so consumes
              the existing phrase; you'll be shown a fresh one
              immediately.
            </p>
            {rotateView === "error" && (
              <div class="chalk-auth-error" data-testid="profile-rotate-error">
                {rotateError}
              </div>
            )}
            <button
              type="button"
              class="chalk-button chalk-button--secondary"
              onClick={startRotate}
              disabled={rotateView === "loading"}
              data-testid="profile-rotate-button"
            >
              {rotateView === "loading" ? "rotating..." : "rotate recovery code"}
            </button>
          </section>
        </div>
      </div>
    </div>
  );
}

function friendlyEmailChangeError(code: string, message: string): string {
  switch (code) {
    case "bad_email":
      return "that doesn't look like a valid email address.";
    case "same_email":
      return "the new email is the same as your current one.";
    case "email_blacklisted":
      return "that email cannot be used.";
    case "email_taken":
      return "that email is already in use by another account.";
    case "email_pending_elsewhere":
      return "that email has a pending change for another account.";
    default:
      return message || "couldn't start email change; see browser console.";
  }
}

function formatTimestamp(iso: string): string {
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

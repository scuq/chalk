// InvitesPanel: in-chat modal for managing invites. Phase 09c-2.
//
// Opened from the StatusBar menu ("invites" item). Mounted as a
// portal-style overlay (same pattern as CreateChannelModal):
// fixed-position card, click-outside-to-close, Escape closes too.
//
// Three concerns in one screen:
//
//   1. Create-invite form (top): email + optional note + submit
//      button. Inline error display.
//
//   2. My invites list (below): newest-first, each row shows
//      email, status badge, note (if any), expires/used/revoked
//      timestamp, the share URL (with copy button) for active
//      rows, and a revoke button for active rows.
//
//   3. Load state + transient errors: spinner while listing,
//      error banner if list fetch failed, per-row revoke error.
//
// The panel itself doesn't fetch on open -- that's the caller's
// (App.tsx) responsibility, triggered by the open_panel action via
// a useEffect. This keeps the component pure-ish.

import { useEffect, useState } from "preact/hooks";
import type { MyInvitesState } from "../auth/types";
import type { InviteDTO } from "../auth/api";

interface Props {
  state: MyInvitesState;
  onClose: () => void;
  onCreateFormChange: (field: "email" | "note", value: string) => void;
  onCreateSubmit: () => void;
  onRevoke: (token: string) => void;
  onClearRevokeError: () => void;
}

export function InvitesPanel({
  state,
  onClose,
  onCreateFormChange,
  onCreateSubmit,
  onRevoke,
  onClearRevokeError,
}: Props) {
  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const items = state.items ?? [];

  return (
    <div
      class="chalk-modal-backdrop"
      onClick={(e) => {
        // Click outside the card (on the backdrop itself) closes.
        if (e.target === e.currentTarget) onClose();
      }}
      data-testid="invites-panel-backdrop"
    >
      <div class="chalk-modal" data-testid="invites-panel" role="dialog" aria-label="manage invites">
        <header class="chalk-modal-header">
          <h2>invites</h2>
          <button
            type="button"
            class="chalk-modal-close"
            onClick={onClose}
            aria-label="close"
            data-testid="invites-panel-close"
          >
            ×
          </button>
        </header>

        <div class="chalk-modal-body">
          {/* Create section */}
          <section class="chalk-invites-create">
            <h3>invite someone</h3>
            <InviteCreateForm
              email={state.createForm.email}
              note={state.createForm.note}
              busy={state.createForm.busy}
              errorCode={state.createForm.errorCode}
              errorMessage={state.createForm.errorMessage}
              onChange={onCreateFormChange}
              onSubmit={onCreateSubmit}
            />
          </section>

          {/* List section */}
          <section class="chalk-invites-list-section">
            <h3>your invites</h3>
            {state.loading && items.length === 0 && (
              <p class="chalk-auth-subtitle">loading...</p>
            )}
            {state.loadError && (
              <div class="chalk-auth-error" data-testid="invites-load-error">
                couldn't load invites: {state.loadError}
              </div>
            )}
            {!state.loading && !state.loadError && items.length === 0 && (
              <p class="chalk-auth-subtitle">
                you haven't issued any invites yet.
              </p>
            )}
            {items.length > 0 && (
              <ul class="chalk-invites-list" data-testid="invites-list">
                {items.map((inv) => (
                  <InviteRow
                    key={inv.token}
                    invite={inv}
                    revoking={state.revokingToken === inv.token}
                    revokeError={state.revokeError && state.revokeError.token === inv.token
                      ? state.revokeError
                      : null}
                    onRevoke={() => onRevoke(inv.token)}
                    onClearRevokeError={onClearRevokeError}
                  />
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

// ---- create form ------------------------------------------------------

interface CreateFormProps {
  email: string;
  note: string;
  busy: boolean;
  errorCode: string | null;
  errorMessage: string | null;
  onChange: (field: "email" | "note", value: string) => void;
  onSubmit: () => void;
}

function InviteCreateForm({
  email,
  note,
  busy,
  errorCode,
  errorMessage,
  onChange,
  onSubmit,
}: CreateFormProps) {
  const handleSubmit = (e: Event) => {
    e.preventDefault();
    if (busy) return;
    if (!email.trim()) return;
    onSubmit();
  };
  const bannerError = errorCode && errorMessage
    ? friendlyCreateError(errorCode, errorMessage)
    : null;
  return (
    <form class="chalk-auth-form" onSubmit={handleSubmit} data-testid="invites-create-form">
      {bannerError && (
        <div class="chalk-auth-error" data-testid="invites-create-error">
          {bannerError}
        </div>
      )}
      <div class="chalk-field">
        <label class="chalk-field-label" for="invites-create-email">email</label>
        <input
          id="invites-create-email"
          class="chalk-field-input"
          type="email"
          autoComplete="email"
          autoCapitalize="none"
          required
          value={email}
          disabled={busy}
          onInput={(e) => onChange("email", (e.target as HTMLInputElement).value)}
          data-testid="invites-create-email"
        />
        <span class="chalk-field-hint">
          the email address the invite link will be sent to
        </span>
      </div>
      <div class="chalk-field">
        <label class="chalk-field-label" for="invites-create-note">
          note <span class="chalk-field-optional">(optional)</span>
        </label>
        <input
          id="invites-create-note"
          class="chalk-field-input"
          type="text"
          maxLength={500}
          value={note}
          disabled={busy}
          onInput={(e) => onChange("note", (e.target as HTMLInputElement).value)}
          data-testid="invites-create-note"
        />
        <span class="chalk-field-hint">
          shown to the invitee in the email body
        </span>
      </div>
      <button
        type="submit"
        class="chalk-button chalk-button--primary"
        disabled={busy || !email.trim()}
        data-testid="invites-create-submit"
      >
        {busy ? "sending..." : "send invite"}
      </button>
    </form>
  );
}

function friendlyCreateError(code: string, message: string): string {
  switch (code) {
    case "bad_email":
      return "that doesn't look like a valid email address.";
    case "note_too_long":
      return "the note is too long; max 500 characters.";
    case "email_taken":
      return "that email already belongs to a chalk user.";
    case "email_blacklisted":
      return "that email cannot be invited.";
    case "invite_active":
      return "there's already an outstanding invite for that address. revoke the existing one or wait for it to expire before issuing a new one.";
    default:
      return message || "couldn't send invite; see browser console.";
  }
}

// ---- invite row -------------------------------------------------------

interface RowProps {
  invite: InviteDTO;
  revoking: boolean;
  revokeError: { code: string; message: string } | null;
  onRevoke: () => void;
  onClearRevokeError: () => void;
}

function InviteRow({ invite, revoking, revokeError, onRevoke, onClearRevokeError }: RowProps) {
  const [copied, setCopied] = useState(false);
  // Reset the "copied!" flash after 2 seconds.
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(t);
  }, [copied]);

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch (e) {
      console.error("clipboard write failed:", e);
    }
  };

  const isActive = invite.status === "active";
  return (
    <li class="chalk-invite-row" data-testid="invite-row" data-status={invite.status}>
      <div class="chalk-invite-row-main">
        <span class="chalk-invite-email">{invite.email}</span>
        <span class={`chalk-invite-status chalk-invite-status--${invite.status}`}>
          {invite.status}
        </span>
      </div>
      {invite.note && (
        <div class="chalk-invite-note">{invite.note}</div>
      )}
      <div class="chalk-invite-meta">
        {invite.status === "active" && (
          <span>expires {formatTimestamp(invite.expires_at)}</span>
        )}
        {invite.status === "used" && invite.used_at && (
          <span>used {formatTimestamp(invite.used_at)}</span>
        )}
        {invite.status === "revoked" && invite.revoked_at && (
          <span>revoked {formatTimestamp(invite.revoked_at)}</span>
        )}
        {invite.status === "expired" && (
          <span>expired {formatTimestamp(invite.expires_at)}</span>
        )}
      </div>
      {isActive && invite.url && (
        <div class="chalk-invite-url-row">
          <code class="chalk-invite-url" data-testid="invite-url">{invite.url}</code>
          <button
            type="button"
            class="chalk-button chalk-button--secondary"
            onClick={() => copy(invite.url!)}
            data-testid="invite-copy"
          >
            {copied ? "copied!" : "copy"}
          </button>
        </div>
      )}
      {isActive && (
        <div class="chalk-invite-actions">
          <button
            type="button"
            class="chalk-button chalk-button--secondary"
            onClick={onRevoke}
            disabled={revoking}
            data-testid="invite-revoke"
          >
            {revoking ? "revoking..." : "revoke"}
          </button>
        </div>
      )}
      {revokeError && (
        <div class="chalk-auth-error" data-testid="invite-revoke-error">
          revoke failed: {revokeError.message}
          <button
            type="button"
            class="chalk-auth-link"
            onClick={onClearRevokeError}
          >
            dismiss
          </button>
        </div>
      )}
    </li>
  );
}

// formatTimestamp renders an ISO 8601 string as a short local-time
// display ("Mon Jun 3, 2:15 PM"). Plain Intl; falls back to the raw
// string if parsing fails.
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

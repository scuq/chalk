// ConfirmModal: generic destructive-action confirmation dialog.
// Phase 09d-2b.
//
// Used by the admin panel for purge, soft-delete, and block actions.
// Same portal/escape/click-outside pattern as InvitesPanel.
//
// Props:
//   open       — whether the modal is visible. When false, nothing renders.
//   title      — short header text (e.g. "Purge user?").
//   body       — explanatory text or JSX shown in the modal body.
//   confirmLabel — text on the confirm button (e.g. "Purge").
//   danger     — if true, the confirm button uses the danger variant
//                (red) and the body is prefixed with a warning glyph.
//   busy       — disables the confirm button while the parent's action
//                is in flight. Cancel stays enabled so the user can
//                click away if they change their mind during the
//                roundtrip.
//   onConfirm  — called when the user clicks confirm. Parent runs the
//                action and toggles busy back when done.
//   onCancel   — called on cancel / escape / click-outside.

import { useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";

interface Props {
  open: boolean;
  title: string;
  body: ComponentChildren;
  confirmLabel: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel,
  danger,
  busy,
  onConfirm,
  onCancel,
}: Props) {
  // Close on Escape.
  useEffect(() => {
    if (!open) return undefined;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      class="chalk-modal-backdrop"
      data-testid="confirm-modal-backdrop"
      onClick={(e) => {
        // Click-outside closes — but only if the user clicked the
        // backdrop itself, not bubbled from inside the modal.
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        class="chalk-modal chalk-modal--confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        data-testid="confirm-modal"
      >
        <header class="chalk-modal-header">
          <h2 id="confirm-modal-title">{title}</h2>
        </header>
        <div class="chalk-modal-body">
          {danger && (
            <div class="chalk-admin-confirm-warning" aria-hidden="true">⚠</div>
          )}
          <div class="chalk-admin-confirm-body">{body}</div>
        </div>
        <footer class="chalk-modal-footer">
          <button
            type="button"
            class="chalk-button"
            onClick={onCancel}
            data-testid="confirm-modal-cancel"
          >
            cancel
          </button>
          <button
            type="button"
            class={`chalk-button ${danger ? "chalk-button--danger" : "chalk-button--primary"}`}
            disabled={busy}
            onClick={onConfirm}
            data-testid="confirm-modal-confirm"
          >
            {busy ? "working..." : confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}

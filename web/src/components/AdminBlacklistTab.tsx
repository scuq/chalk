// AdminBlacklistTab: the blacklist tab of the admin moderation panel.
// Phase 09d-2b.
//
// Two sections:
//   - Add form (top): email + reason fields, submit button.
//   - Entry list (below): paginated, each row has a remove button.
//
// No confirm modal on remove because it's not destructive — removing
// just lets that email register again; the admin can re-add later.
//
// Empty state: shown when the list is loaded and has zero entries.

import type { BlacklistEntry } from "../auth/admin";

export interface AdminBlacklistState {
  entries: BlacklistEntry[];
  total: number;
  limit: number;
  offset: number;
  loading: boolean;
  loadError: string | null;
  // Add form:
  addForm: { email: string; reason: string };
  addBusy: boolean;
  addError: string | null;
  // Per-entry remove in-flight (keyed by lowercased email).
  pendingRemoveEmail: string | null;
  removeError: string | null;
}

interface Props {
  state: AdminBlacklistState;
  onPageChange: (offset: number) => void;
  onRefresh: () => void;
  onAddFormChange: (field: "email" | "reason", value: string) => void;
  onAddSubmit: () => void;
  onRemove: (email: string) => void;
  onAddErrorDismiss: () => void;
  onRemoveErrorDismiss: () => void;
}

const PAGE_LIMIT = 50;

export function AdminBlacklistTab({
  state,
  onPageChange,
  onRefresh,
  onAddFormChange,
  onAddSubmit,
  onRemove,
  onAddErrorDismiss,
  onRemoveErrorDismiss,
}: Props) {
  // Local: track the form submission button enable state. The add
  // form is "ready" when both fields have non-empty values.
  const canSubmit =
    state.addForm.email.trim().length > 0 &&
    state.addForm.reason.trim().length > 0 &&
    !state.addBusy;

  const onFormSubmit = (e: Event) => {
    e.preventDefault();
    if (!canSubmit) return;
    onAddSubmit();
  };

  const pageNum = Math.floor(state.offset / PAGE_LIMIT) + 1;
  const totalPages = Math.max(1, Math.ceil(state.total / PAGE_LIMIT));
  const hasPrev = state.offset > 0;
  const hasNext = state.offset + state.limit < state.total;

  return (
    <div class="chalk-admin-tab" data-testid="admin-blacklist-tab">
      {/* Add form */}
      <form
        class="chalk-admin-blacklist-add"
        onSubmit={onFormSubmit}
        data-testid="admin-blacklist-add-form"
      >
        <div class="chalk-field">
          <label class="chalk-field-label" for="admin-blacklist-email">
            email
          </label>
          <input
            id="admin-blacklist-email"
            class="chalk-field-input"
            type="email"
            required
            value={state.addForm.email}
            disabled={state.addBusy}
            onInput={(e) =>
              onAddFormChange("email", (e.target as HTMLInputElement).value)
            }
            data-testid="admin-blacklist-add-email"
            autoComplete="off"
            autoCapitalize="none"
            spellcheck={false}
          />
        </div>
        <div class="chalk-field">
          <label class="chalk-field-label" for="admin-blacklist-reason">
            reason
          </label>
          <input
            id="admin-blacklist-reason"
            class="chalk-field-input"
            type="text"
            required
            maxLength={200}
            value={state.addForm.reason}
            disabled={state.addBusy}
            onInput={(e) =>
              onAddFormChange("reason", (e.target as HTMLInputElement).value)
            }
            placeholder="e.g. abuse, spam"
            data-testid="admin-blacklist-add-reason"
          />
        </div>
        <button
          type="submit"
          class="chalk-button chalk-button--primary"
          disabled={!canSubmit}
          data-testid="admin-blacklist-add-submit"
        >
          {state.addBusy ? "adding..." : "add to blacklist"}
        </button>
      </form>

      {state.addError && (
        <div class="chalk-admin-action-error" data-testid="admin-blacklist-add-error">
          <span>add failed: {state.addError}</span>
          <button
            type="button"
            class="chalk-admin-action-error-dismiss"
            onClick={onAddErrorDismiss}
            aria-label="dismiss"
          >
            ×
          </button>
        </div>
      )}

      {state.removeError && (
        <div class="chalk-admin-action-error" data-testid="admin-blacklist-remove-error">
          <span>remove failed: {state.removeError}</span>
          <button
            type="button"
            class="chalk-admin-action-error-dismiss"
            onClick={onRemoveErrorDismiss}
            aria-label="dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Toolbar: refresh button (no search yet — blacklists tend to
          be small; can add later if needed) */}
      <div class="chalk-admin-toolbar">
        <div class="chalk-admin-toolbar-title">blacklisted addresses</div>
        <button
          type="button"
          class="chalk-button chalk-admin-refresh"
          onClick={onRefresh}
          disabled={state.loading}
          data-testid="admin-blacklist-refresh"
        >
          {state.loading ? "loading..." : "refresh"}
        </button>
      </div>

      {state.loadError && (
        <div class="chalk-auth-error" data-testid="admin-blacklist-load-error">
          load failed: {state.loadError}
        </div>
      )}

      {state.total === 0 && !state.loading ? (
        <div class="chalk-admin-empty" data-testid="admin-blacklist-empty">
          blacklist is empty
        </div>
      ) : (
        <div class="chalk-admin-table-wrap">
          <table
            class="chalk-admin-table chalk-admin-table--blacklist"
            data-testid="admin-blacklist-table"
          >
            <thead>
              <tr>
                <th>email</th>
                <th>reason</th>
                <th>former user</th>
                <th>added</th>
                <th class="chalk-admin-table-actions-col" aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {state.entries.map((entry) => (
                <BlacklistRow
                  key={entry.email}
                  entry={entry}
                  pending={state.pendingRemoveEmail === entry.email}
                  onRemove={onRemove}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {state.total > 0 && (
        <div class="chalk-admin-pagination" data-testid="admin-blacklist-pagination">
          <button
            type="button"
            class="chalk-button"
            disabled={!hasPrev || state.loading}
            onClick={() => onPageChange(Math.max(0, state.offset - state.limit))}
            data-testid="admin-blacklist-prev"
          >
            ← prev
          </button>
          <span class="chalk-admin-pagination-label">
            page {pageNum} of {totalPages}
            {" · "}
            {state.total} {state.total === 1 ? "entry" : "entries"}
          </span>
          <button
            type="button"
            class="chalk-button"
            disabled={!hasNext || state.loading}
            onClick={() => onPageChange(state.offset + state.limit)}
            data-testid="admin-blacklist-next"
          >
            next →
          </button>
        </div>
      )}
    </div>
  );
}

interface BlacklistRowProps {
  entry: BlacklistEntry;
  pending: boolean;
  onRemove: (email: string) => void;
}

function BlacklistRow({ entry, pending, onRemove }: BlacklistRowProps) {
  const addedShort = (() => {
    try {
      return new Date(entry.added_at).toISOString().slice(0, 10);
    } catch {
      return entry.added_at;
    }
  })();

  // Former user column: display "username (id-prefix)" if present,
  // otherwise an em-dash for "manually-added, never a real user".
  const formerUser = entry.former_username
    ? `${entry.former_username}${entry.former_user_id ? " (" + entry.former_user_id.slice(0, 8) + ")" : ""}`
    : entry.former_user_id
      ? entry.former_user_id.slice(0, 8) + "…"
      : null;

  return (
    <tr
      class="chalk-admin-row"
      data-testid="admin-blacklist-row"
      data-blacklist-email={entry.email}
    >
      <td class="chalk-admin-cell-email">{entry.email}</td>
      <td class="chalk-admin-cell-reason">{entry.reason}</td>
      <td class="chalk-admin-cell-former">
        {formerUser ?? <span class="chalk-fg-dim">—</span>}
      </td>
      <td class="chalk-admin-cell-created">{addedShort}</td>
      <td class="chalk-admin-cell-actions">
        {pending ? (
          <span class="chalk-admin-row-pending">…</span>
        ) : (
          <div class="chalk-admin-row-actions">
            <button
              type="button"
              class="chalk-admin-row-action"
              onClick={() => onRemove(entry.email)}
              data-testid="admin-blacklist-action-remove"
              title="remove this email from the blacklist (allows registration again)"
            >
              remove
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}

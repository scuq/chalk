// AdminUsersTab: the users-list tab of the admin moderation panel.
// Phase 09d-2b.
//
// Renders the paginated users table with search + per-row actions.
// All state lives in the parent (App reducer's adminPanel slice);
// this component is purely presentational + handlers.
//
// Row actions on hover: block/unblock, soft-delete, purge. Admin
// rows show no actions (server enforces, client just hides).
//
// Pagination: prev/next + "page N of M" label. We don't show a
// page-jump input because the server caps at 200/page so even 10k
// users only need 50 pages, and prev/next is easy enough.
//
// Empty state: when total=0 and not loading, we show a friendly
// "no users yet" message in place of the table.

import { useEffect, useRef, useState } from "preact/hooks";
import type { AdminUser } from "../auth/admin";

// Mirror of the reducer's AdminUsersState. Imported as a structural
// type here so this component can be reused with mock data in tests
// without depending on the reducer module.
export interface AdminUsersState {
  users: AdminUser[];
  total: number;
  limit: number;
  offset: number;
  q: string;
  loading: boolean;
  loadError: string | null;
  pendingActionUserID: string | null;
  actionError: string | null;
}

interface Props {
  state: AdminUsersState;
  // ownUserID: the currently-logged-in admin's id. Used to hide row
  // actions on the admin's own row (server also refuses, but it's
  // cleaner to not show buttons that won't work).
  ownUserID: string | null;
  onSearchChange: (q: string) => void;
  onPageChange: (offset: number) => void;
  onRefresh: () => void;
  onAction: (
    userID: string,
    action: "block" | "unblock" | "soft-delete" | "purge",
  ) => void;
  onActionErrorDismiss: () => void;
}

const PAGE_LIMIT = 50;

export function AdminUsersTab({
  state,
  ownUserID,
  onSearchChange,
  onPageChange,
  onRefresh,
  onAction,
  onActionErrorDismiss,
}: Props) {
  // Local input state for the search box. The reducer holds the
  // *committed* q; this input mirrors what the user is typing. We
  // sync from reducer → local whenever state.q changes from
  // outside (e.g. tab switch, refresh), but only when the user
  // isn't actively typing in the box (focus check) — otherwise we'd
  // stomp on their input mid-keystroke if a re-render happens to
  // fire because of an unrelated state change.
  const [searchInput, setSearchInput] = useState(state.q);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    if (state.q !== searchInput) {
      setSearchInput(state.q);
    }
    // We intentionally depend only on state.q here: the effect's
    // purpose is to mirror the *external* q into the local input.
    // Adding searchInput to deps would create a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.q]);

  const onSearchInput = (e: Event) => {
    const value = (e.target as HTMLInputElement).value;
    setSearchInput(value);
    // Forward immediately to the reducer; the parent (AdminPanel)
    // owns the debounced effect that turns q changes into requests.
    onSearchChange(value);
  };

  const onSearchSubmit = (e: Event) => {
    e.preventDefault();
    // Submit forces an immediate refresh (skip debounce). The parent's
    // effect will see the q change and fire the request.
    onRefresh();
  };

  const pageNum = Math.floor(state.offset / PAGE_LIMIT) + 1;
  const totalPages = Math.max(1, Math.ceil(state.total / PAGE_LIMIT));
  const hasPrev = state.offset > 0;
  const hasNext = state.offset + state.limit < state.total;

  return (
    <div class="chalk-admin-tab" data-testid="admin-users-tab">
      {/* Toolbar: search + refresh */}
      <div class="chalk-admin-toolbar">
        <form class="chalk-admin-search" onSubmit={onSearchSubmit}>
          <input
            ref={inputRef}
            type="search"
            class="chalk-field-input"
            placeholder="search users (username, display name, email)"
            value={searchInput}
            onInput={onSearchInput}
            data-testid="admin-users-search-input"
            autoComplete="off"
            spellcheck={false}
          />
        </form>
        <button
          type="button"
          class="chalk-button chalk-admin-refresh"
          onClick={onRefresh}
          disabled={state.loading}
          data-testid="admin-users-refresh"
          title="refresh"
        >
          {state.loading ? "loading..." : "refresh"}
        </button>
      </div>

      {/* Load error banner */}
      {state.loadError && (
        <div class="chalk-auth-error" data-testid="admin-users-load-error">
          load failed: {state.loadError}
        </div>
      )}

      {/* Action error banner (dismissable) */}
      {state.actionError && (
        <div class="chalk-admin-action-error" data-testid="admin-users-action-error">
          <span>{state.actionError}</span>
          <button
            type="button"
            class="chalk-admin-action-error-dismiss"
            onClick={onActionErrorDismiss}
            aria-label="dismiss"
          >
            ×
          </button>
        </div>
      )}

      {/* Table or empty state */}
      {state.total === 0 && !state.loading ? (
        <div class="chalk-admin-empty" data-testid="admin-users-empty">
          {state.q
            ? `no users match "${state.q}"`
            : "no users yet"}
        </div>
      ) : (
        <div class="chalk-admin-table-wrap">
          <table class="chalk-admin-table" data-testid="admin-users-table">
            <thead>
              <tr>
                <th>username</th>
                <th>display name</th>
                <th>email</th>
                <th>status</th>
                <th>created</th>
                <th class="chalk-admin-table-actions-col" aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {state.users.map((u) => (
                <UserRow
                  key={u.id}
                  user={u}
                  ownUserID={ownUserID}
                  pending={state.pendingActionUserID === u.id}
                  onAction={onAction}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {state.total > 0 && (
        <div class="chalk-admin-pagination" data-testid="admin-users-pagination">
          <button
            type="button"
            class="chalk-button"
            disabled={!hasPrev || state.loading}
            onClick={() => onPageChange(Math.max(0, state.offset - state.limit))}
            data-testid="admin-users-prev"
          >
            ← prev
          </button>
          <span class="chalk-admin-pagination-label" data-testid="admin-users-page-label">
            page {pageNum} of {totalPages}
            {" · "}
            {state.total} {state.total === 1 ? "user" : "users"}
          </span>
          <button
            type="button"
            class="chalk-button"
            disabled={!hasNext || state.loading}
            onClick={() => onPageChange(state.offset + state.limit)}
            data-testid="admin-users-next"
          >
            next →
          </button>
        </div>
      )}
    </div>
  );
}

interface UserRowProps {
  user: AdminUser;
  ownUserID: string | null;
  pending: boolean;
  onAction: (
    userID: string,
    action: "block" | "unblock" | "soft-delete" | "purge",
  ) => void;
}

function UserRow({ user, ownUserID, pending, onAction }: UserRowProps) {
  const isAdmin = user.role === "admin";
  const isSelf = ownUserID === user.id;
  const isBlocked = !!user.blocked_at;
  const isDeleted = !!user.deleted_at;

  // Compute the status pill. Server returns user.status as well, but
  // we trust the flags + role over the derived string since the
  // booleans determine action availability anyway.
  const status: "admin" | "active" | "blocked" | "deleted" =
    isDeleted ? "deleted" :
    isBlocked ? "blocked" :
    isAdmin ? "admin" :
    "active";

  // Actions disabled when:
  //   - row is the admin themselves (server refuses; UX clarity)
  //   - row is already in a destructive state (deleted)
  //   - row's action is in flight (pending)
  const canBlock = !isAdmin && !isSelf && !isBlocked && !isDeleted;
  const canUnblock = !isAdmin && !isSelf && isBlocked && !isDeleted;
  const canSoftDelete = !isAdmin && !isSelf && !isDeleted;
  const canPurge = !isAdmin && !isSelf;

  // Created date formatting. user.created_at is an ISO string.
  const createdShort = (() => {
    try {
      return new Date(user.created_at).toISOString().slice(0, 10);
    } catch {
      return user.created_at;
    }
  })();

  return (
    <tr
      class={`chalk-admin-row chalk-admin-row--${status}`}
      data-testid="admin-users-row"
      data-user-id={user.id}
      data-status={status}
    >
      <td class="chalk-admin-cell-username">{user.username}</td>
      <td class="chalk-admin-cell-displayname">
        {user.display_name || <span class="chalk-fg-dim">—</span>}
      </td>
      <td class="chalk-admin-cell-email">{user.email}</td>
      <td class="chalk-admin-cell-status">
        <span
          class={`chalk-admin-status-pill chalk-admin-status-pill--${status}`}
          data-testid="admin-user-status-pill"
        >
          {status}
        </span>
      </td>
      <td class="chalk-admin-cell-created">{createdShort}</td>
      <td class="chalk-admin-cell-actions">
        {pending ? (
          <span class="chalk-admin-row-pending" data-testid="admin-user-row-pending">
            …
          </span>
        ) : (
          <div class="chalk-admin-row-actions" data-testid="admin-user-row-actions">
            {canBlock && (
              <button
                type="button"
                class="chalk-admin-row-action"
                onClick={() => onAction(user.id, "block")}
                data-testid="admin-user-action-block"
                title="block this user (they can't log in until unblocked; active sessions are kicked)"
              >
                block
              </button>
            )}
            {canUnblock && (
              <button
                type="button"
                class="chalk-admin-row-action"
                onClick={() => onAction(user.id, "unblock")}
                data-testid="admin-user-action-unblock"
                title="unblock this user (they can log in again)"
              >
                unblock
              </button>
            )}
            {canSoftDelete && (
              <button
                type="button"
                class="chalk-admin-row-action chalk-admin-row-action--warn"
                onClick={() => onAction(user.id, "soft-delete")}
                data-testid="admin-user-action-soft-delete"
                title="soft-delete: the user can't log in; messages preserved; reversible by support"
              >
                soft-delete
              </button>
            )}
            {canPurge && (
              <button
                type="button"
                class="chalk-admin-row-action chalk-admin-row-action--danger"
                onClick={() => onAction(user.id, "purge")}
                data-testid="admin-user-action-purge"
                title="PURGE: irreversible; deletes the user row AND blacklists their email"
              >
                purge
              </button>
            )}
          </div>
        )}
      </td>
    </tr>
  );
}

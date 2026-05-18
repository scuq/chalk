// AdminPanel: top-level container for the admin moderation panel.
// Phase 09d-2b.
//
// Renders when state.route === "admin" AND me.role === "admin".
// Non-admins reaching this code path are bounced by App.tsx before
// the panel mounts, so we don't gate again here.
//
// Three responsibilities:
//   1. Tab switcher (users / blacklist).
//   2. Data-loading effects: when a tab becomes active or its
//      pagination/search changes, fire the right API call.
//   3. Render the active tab + the (shared) ConfirmModal for the
//      destructive moderation actions.
//
// All state lives in the reducer; this component reads and dispatches.

import { useEffect, useRef } from "preact/hooks";
import { AdminUsersTab } from "./AdminUsersTab";
import { AdminBlacklistTab } from "./AdminBlacklistTab";
import { ConfirmModal } from "./ConfirmModal";
import {
  listUsers,
  blockUser,
  unblockUser,
  softDeleteUser,
  purgeUser,
  listBlacklist,
  addToBlacklist,
  removeFromBlacklist,
} from "../auth/admin";
import { ApiError } from "../auth/api";
import type { Action } from "../state/types";
import type { AdminPanelState } from "../state/types";

interface Props {
  state: AdminPanelState;
  ownUserID: string | null;
  dispatch: (action: Action) => void;
  onBackToChat: () => void;
}

// Debounce window for the user-list search input (ms). Short enough
// to feel responsive, long enough to coalesce a fast typist.
const SEARCH_DEBOUNCE_MS = 250;

export function AdminPanel({
  state,
  ownUserID,
  dispatch,
  onBackToChat,
}: Props) {
  // ---- Data-loading effects ------------------------------------------

  // Users tab: fetch when q/offset/limit changes (with debounce on q).
  // We use a ref to hold the latest fetch params so the effect's
  // cleanup can cancel a debounce if the user keeps typing.
  const usersFetchRef = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    inflight: number;
  }>({ timer: null, inflight: 0 });

  useEffect(() => {
    if (state.activeTab !== "users") return undefined;
    // Cancel any pending debounced fetch.
    if (usersFetchRef.current.timer) {
      clearTimeout(usersFetchRef.current.timer);
      usersFetchRef.current.timer = null;
    }
    const myInflight = ++usersFetchRef.current.inflight;
    const run = async () => {
      dispatch({ kind: "admin_users_load_start" });
      try {
        const resp = await listUsers({
          q: state.users.q,
          limit: state.users.limit,
          offset: state.users.offset,
        });
        // Ignore if a newer fetch has been issued since.
        if (myInflight !== usersFetchRef.current.inflight) return;
        dispatch({
          kind: "admin_users_load_succeeded",
          users: resp.users,
          total: resp.total,
          limit: resp.limit,
          offset: resp.offset,
        });
      } catch (err) {
        if (myInflight !== usersFetchRef.current.inflight) return;
        const message = err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error ? err.message : String(err);
        dispatch({ kind: "admin_users_load_failed", message });
      }
    };
    // Debounce only on q changes — pagination + tab activation fire
    // immediately. We can't tell from inside the effect whether q
    // changed vs offset; the parent reducer marks q changes with a
    // searchPending flag.
    if (state.users.searchPending) {
      usersFetchRef.current.timer = setTimeout(() => {
        usersFetchRef.current.timer = null;
        run();
      }, SEARCH_DEBOUNCE_MS);
      return () => {
        if (usersFetchRef.current.timer) {
          clearTimeout(usersFetchRef.current.timer);
          usersFetchRef.current.timer = null;
        }
      };
    }
    run();
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.activeTab,
    state.users.q,
    state.users.limit,
    state.users.offset,
    state.users.refreshTick,
  ]);

  // Blacklist tab: fetch when tab becomes active or pagination
  // changes or refreshTick increments. No search yet.
  useEffect(() => {
    if (state.activeTab !== "blacklist") return undefined;
    let cancelled = false;
    const run = async () => {
      dispatch({ kind: "admin_blacklist_load_start" });
      try {
        const resp = await listBlacklist({
          limit: state.blacklist.limit,
          offset: state.blacklist.offset,
        });
        if (cancelled) return;
        dispatch({
          kind: "admin_blacklist_load_succeeded",
          entries: resp.entries,
          total: resp.total,
          limit: resp.limit,
          offset: resp.offset,
        });
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof ApiError
          ? `${err.code}: ${err.message}`
          : err instanceof Error ? err.message : String(err);
        dispatch({ kind: "admin_blacklist_load_failed", message });
      }
    };
    run();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.activeTab,
    state.blacklist.limit,
    state.blacklist.offset,
    state.blacklist.refreshTick,
  ]);

  // ---- User-action handlers -----------------------------------------

  // For block/unblock: fire immediately, no confirm modal (block is
  // reversible). For soft-delete and purge: open the confirm modal
  // first; the modal's onConfirm calls runUserAction.
  const onUserAction = (
    userID: string,
    action: "block" | "unblock" | "soft-delete" | "purge",
  ) => {
    if (action === "block" || action === "unblock") {
      runUserAction(userID, action);
      return;
    }
    dispatch({ kind: "admin_users_confirm_open", userID, action });
  };

  const runUserAction = async (
    userID: string,
    action: "block" | "unblock" | "soft-delete" | "purge",
  ) => {
    dispatch({ kind: "admin_users_action_start", userID });
    try {
      switch (action) {
        case "block": await blockUser(userID); break;
        case "unblock": await unblockUser(userID); break;
        case "soft-delete": await softDeleteUser(userID); break;
        case "purge": await purgeUser(userID); break;
      }
      dispatch({ kind: "admin_users_action_succeeded", userID, action });
      // Trigger a list refresh so the row's new state is reflected.
      dispatch({ kind: "admin_users_refresh" });
    } catch (err) {
      const message = err instanceof ApiError
        ? `${err.code}: ${err.message}`
        : err instanceof Error ? err.message : String(err);
      dispatch({
        kind: "admin_users_action_failed",
        userID,
        action,
        message,
      });
    }
  };

  // ---- Blacklist handlers -------------------------------------------

  const onBlacklistAdd = async () => {
    dispatch({ kind: "admin_blacklist_add_start" });
    try {
      await addToBlacklist({
        email: state.blacklist.addForm.email.trim().toLowerCase(),
        reason: state.blacklist.addForm.reason.trim(),
      });
      dispatch({ kind: "admin_blacklist_add_succeeded" });
      dispatch({ kind: "admin_blacklist_refresh" });
    } catch (err) {
      const message = err instanceof ApiError
        ? `${err.code}: ${err.message}`
        : err instanceof Error ? err.message : String(err);
      dispatch({ kind: "admin_blacklist_add_failed", message });
    }
  };

  const onBlacklistRemove = async (email: string) => {
    dispatch({ kind: "admin_blacklist_remove_start", email });
    try {
      await removeFromBlacklist(email);
      dispatch({ kind: "admin_blacklist_remove_succeeded", email });
      dispatch({ kind: "admin_blacklist_refresh" });
    } catch (err) {
      const message = err instanceof ApiError
        ? `${err.code}: ${err.message}`
        : err instanceof Error ? err.message : String(err);
      dispatch({ kind: "admin_blacklist_remove_failed", email, message });
    }
  };

  // ---- Render --------------------------------------------------------

  const confirmAction = state.users.confirm;
  let confirmTitle = "";
  let confirmBody: preact.ComponentChildren = "";
  let confirmLabel = "";
  let confirmDanger = false;
  if (confirmAction) {
    const target = state.users.users.find((u) => u.id === confirmAction.userID);
    const who = target
      ? `${target.username} (${target.email})`
      : confirmAction.userID;
    if (confirmAction.action === "soft-delete") {
      confirmTitle = "soft-delete user?";
      confirmBody = (
        <>
          <p>
            Soft-delete <strong>{who}</strong>?
          </p>
          <p>
            They won't be able to log in. Their messages stay in
            channels. Active sessions get kicked. Reversible by
            support (manual SQL).
          </p>
        </>
      );
      confirmLabel = "soft-delete";
      confirmDanger = false;
    } else if (confirmAction.action === "purge") {
      confirmTitle = "PURGE user?";
      confirmBody = (
        <>
          <p>
            Purge <strong>{who}</strong>?
          </p>
          <p>
            <strong>This is irreversible.</strong> The user row is
            deleted. Their email is added to the blacklist with
            reason "purged_user" so it can't be re-registered. Active
            sessions get kicked. Messages stay (the sender field
            becomes null).
          </p>
        </>
      );
      confirmLabel = "PURGE";
      confirmDanger = true;
    }
  }

  return (
    <div class="chalk-admin chalk-admin--full" data-testid="admin-panel">
      <header class="chalk-admin-header">
        <button
          type="button"
          class="chalk-button chalk-admin-back"
          onClick={onBackToChat}
          data-testid="admin-back"
        >
          ← back to chat
        </button>
        <h2 class="chalk-admin-title">admin</h2>
        <nav class="chalk-admin-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={state.activeTab === "users"}
            class={`chalk-admin-tab-btn ${state.activeTab === "users" ? "chalk-admin-tab-btn--active" : ""}`}
            onClick={() => dispatch({ kind: "admin_tab_change", tab: "users" })}
            data-testid="admin-tab-users"
          >
            users
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={state.activeTab === "blacklist"}
            class={`chalk-admin-tab-btn ${state.activeTab === "blacklist" ? "chalk-admin-tab-btn--active" : ""}`}
            onClick={() => dispatch({ kind: "admin_tab_change", tab: "blacklist" })}
            data-testid="admin-tab-blacklist"
          >
            blacklist
          </button>
        </nav>
      </header>

      <div class="chalk-admin-body">
        {state.activeTab === "users" && (
          <AdminUsersTab
            state={state.users}
            ownUserID={ownUserID}
            onSearchChange={(q) =>
              dispatch({ kind: "admin_users_search_change", q })
            }
            onPageChange={(offset) =>
              dispatch({ kind: "admin_users_page_change", offset })
            }
            onRefresh={() => dispatch({ kind: "admin_users_refresh" })}
            onAction={onUserAction}
            onActionErrorDismiss={() =>
              dispatch({ kind: "admin_users_action_error_dismissed" })
            }
          />
        )}
        {state.activeTab === "blacklist" && (
          <AdminBlacklistTab
            state={state.blacklist}
            onPageChange={(offset) =>
              dispatch({ kind: "admin_blacklist_page_change", offset })
            }
            onRefresh={() => dispatch({ kind: "admin_blacklist_refresh" })}
            onAddFormChange={(field, value) =>
              dispatch({ kind: "admin_blacklist_add_form_change", field, value })
            }
            onAddSubmit={onBlacklistAdd}
            onRemove={onBlacklistRemove}
            onAddErrorDismiss={() =>
              dispatch({ kind: "admin_blacklist_add_error_dismissed" })
            }
            onRemoveErrorDismiss={() =>
              dispatch({ kind: "admin_blacklist_remove_error_dismissed" })
            }
          />
        )}
      </div>

      <ConfirmModal
        open={!!confirmAction}
        title={confirmTitle}
        body={confirmBody}
        confirmLabel={confirmLabel}
        danger={confirmDanger}
        busy={
          !!confirmAction &&
          state.users.pendingActionUserID === confirmAction.userID
        }
        onConfirm={() => {
          if (!confirmAction) return;
          // Close the modal optimistically; the row pending spinner
          // takes over until the action completes.
          dispatch({ kind: "admin_users_confirm_close" });
          runUserAction(confirmAction.userID, confirmAction.action);
        }}
        onCancel={() => dispatch({ kind: "admin_users_confirm_close" })}
      />
    </div>
  );
}

// FriendsPanel: in-chat modal for managing friends. Phase 09f (9.6).
//
// Opened from the StatusBar menu ("friends" item). Mounted as a
// portal-style overlay (same pattern as InvitesPanel + ProfilePanel):
// fixed-position card, click-outside-to-close, Escape closes too.
//
// Three tabs:
//
//   1. "add" — username input (text) + send-request button. The
//      submit flow is: lookup the username via /api/users/lookup;
//      if found, send a friend_request WS frame with the resolved
//      user_id. If not found, surface "no user named <x>". Errors
//      from the WS ack (already friends, blocked, etc.) surface
//      inline. 59-1: below the input, the server directory
//      (/api/users/directory) lists everyone on the server with a
//      one-click "add" per row; rows already friended or pending
//      show a status label instead.
//
//   2. "pending" — two grouped lists: incoming (you can accept or
//      decline) and outgoing (you can cancel; which the wire
//      protocol calls "decline" from the requester side -- the
//      server's handleFriendDecline accepts either party). Empty
//      state when both lists are empty.
//
//   3. "friends" — accepted friends list. Each row has a "remove"
//      action. Confirm prompt avoided for now; the server's
//      handleFriendRemove is idempotent and the user can re-add.
//
// The panel itself doesn't fetch on open -- that's the caller's
// (App.tsx) responsibility, triggered by the open_panel action via
// a useEffect that sends friend_list over the WS. The panel just
// renders whatever the reducer says.

import { useEffect, useState } from "preact/hooks";
import { listUserDirectory } from "../auth/users";
import type { UserLookupResult } from "../auth/users";
import type { FriendsPanelState, Friend } from "../state/types";

interface Props {
  state: FriendsPanelState;
  // Accepted friends + pending buckets. We pull these in as props
  // rather than from FriendsPanelState because they live at the
  // top level of AppState (state.friends, state.pendingIncoming,
  // state.pendingOutgoing) and are shared with the FriendPicker
  // inside CreateChannelModal.
  friends: Friend[];
  pendingIncoming: Friend[];
  pendingOutgoing: Friend[];
  onClose: () => void;
  // "add" tab actions.
  onAddFormChange: (value: string) => void;
  onAddSubmit: () => void;
  onClearAddError: () => void;
  // 59-1: direct add from the server directory (user_id already
  // known, no username lookup roundtrip).
  onAddUser: (userID: string) => void;
  // "pending" and "friends" tab actions.
  onAccept: (userID: string) => void;
  onDecline: (userID: string) => void;
  onRemove: (userID: string) => void;
  // Tab switch.
  onTabChange: (tab: "add" | "pending" | "friends") => void;
  // Refresh re-sends friend_list. Optional.
  onRefresh?: () => void;
}

export function FriendsPanel(props: Props) {
  const {
    state, friends, pendingIncoming, pendingOutgoing,
    onClose, onAddFormChange, onAddSubmit, onClearAddError, onAddUser,
    onAccept, onDecline, onRemove, onTabChange, onRefresh,
  } = props;

  // Escape to close. Click-outside handled via the backdrop element.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const incomingCount = pendingIncoming.length;
  const outgoingCount = pendingOutgoing.length;
  const friendCount = friends.length;
  const pendingTotal = incomingCount + outgoingCount;

  return (
    <div
      class="chalk-modal-backdrop"
      data-testid="friends-panel-backdrop"
      onClick={onClose}
    >
      <div
        class="chalk-modal-card chalk-friends-panel"
        data-testid="friends-panel"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="friends"
      >
        <div class="chalk-friends-header">
          <div class="chalk-friends-title">friends</div>
          <button
            class="chalk-modal-close"
            type="button"
            data-testid="friends-panel-close"
            aria-label="close"
            onClick={onClose}
          >×</button>
        </div>

        <div class="chalk-friends-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            class={`chalk-friends-tab ${state.activeTab === "add" ? "chalk-friends-tab--active" : ""}`}
            aria-selected={state.activeTab === "add"}
            data-testid="friends-tab-add"
            onClick={() => onTabChange("add")}
          >add</button>
          <button
            type="button"
            role="tab"
            class={`chalk-friends-tab ${state.activeTab === "pending" ? "chalk-friends-tab--active" : ""}`}
            aria-selected={state.activeTab === "pending"}
            data-testid="friends-tab-pending"
            onClick={() => onTabChange("pending")}
          >
            pending {pendingTotal > 0 && <span class="chalk-friends-badge">{pendingTotal}</span>}
          </button>
          <button
            type="button"
            role="tab"
            class={`chalk-friends-tab ${state.activeTab === "friends" ? "chalk-friends-tab--active" : ""}`}
            aria-selected={state.activeTab === "friends"}
            data-testid="friends-tab-friends"
            onClick={() => onTabChange("friends")}
          >
            friends {friendCount > 0 && <span class="chalk-friends-badge">{friendCount}</span>}
          </button>
          {onRefresh && (
            <button
              type="button"
              class="chalk-friends-refresh"
              data-testid="friends-refresh"
              onClick={onRefresh}
              aria-label="refresh friends list"
              title="refresh"
            >↻</button>
          )}
        </div>

        <div class="chalk-friends-body">
          {state.activeTab === "add" && (
            <AddTab
              value={state.addInput}
              busy={state.addBusy}
              error={state.addError}
              onChange={onAddFormChange}
              onSubmit={onAddSubmit}
              onClearError={onClearAddError}
              friends={friends}
              pendingIncoming={pendingIncoming}
              pendingOutgoing={pendingOutgoing}
              pendingActionUserID={state.pendingActionUserID}
              onAddUser={onAddUser}
            />
          )}
          {state.activeTab === "pending" && (
            <PendingTab
              incoming={pendingIncoming}
              outgoing={pendingOutgoing}
              pendingActionUserID={state.pendingActionUserID}
              onAccept={onAccept}
              onDecline={onDecline}
            />
          )}
          {state.activeTab === "friends" && (
            <FriendsTab
              friends={friends}
              pendingActionUserID={state.pendingActionUserID}
              onRemove={onRemove}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ---- "add" tab ---------------------------------------------------------

// 59-1: relationship status for a directory row. Friends and pending
// (either direction) rows show a label instead of the add button.
function directoryStatus(
  userID: string,
  friends: Friend[],
  pendingIncoming: Friend[],
  pendingOutgoing: Friend[]
): "friends" | "pending" | null {
  if (friends.some((f) => f.userID === userID)) return "friends";
  if (
    pendingIncoming.some((f) => f.userID === userID) ||
    pendingOutgoing.some((f) => f.userID === userID)
  ) {
    return "pending";
  }
  return null;
}

function AddTab(props: {
  value: string;
  busy: boolean;
  error: string | null;
  onChange: (v: string) => void;
  onSubmit: () => void;
  onClearError: () => void;
  friends: Friend[];
  pendingIncoming: Friend[];
  pendingOutgoing: Friend[];
  pendingActionUserID: string | null;
  onAddUser: (userID: string) => void;
}) {
  const {
    value, busy, error, onChange, onSubmit, onClearError,
    friends, pendingIncoming, pendingOutgoing,
    pendingActionUserID, onAddUser,
  } = props;
  const canSubmit = !busy && value.trim().length >= 3;

  // 59-1: the server directory, fetched fresh each time the tab
  // mounts. Local state on purpose -- it's a read-only listing with
  // no lifecycle beyond this tab, so the reducer has no stake in it.
  const [directory, setDirectory] = useState<UserLookupResult[] | null>(null);
  const [dirError, setDirError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    listUserDirectory()
      .then((users) => {
        if (!cancelled) setDirectory(users);
      })
      .catch((err) => {
        if (!cancelled) {
          setDirError(err instanceof Error ? err.message : String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div class="chalk-friends-add" data-testid="friends-add">
      <p class="chalk-friends-help">
        Enter a username to send a friend request. Usernames are
        lowercase letters, digits, and underscores; 3–32 characters.
      </p>
      <div class="chalk-friends-add-row">
        <input
          type="text"
          class="chalk-friends-add-input"
          placeholder="username"
          data-testid="friends-add-input"
          value={value}
          onInput={(e) => {
            if (error) onClearError();
            onChange((e.target as HTMLInputElement).value);
          }}
          onKeyDown={(e) => {
            // 48-2: an Enter that commits an IME candidate is not a submit.
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter" && canSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
          autoFocus
          disabled={busy}
          maxLength={32}
        />
        <button
          type="button"
          class="chalk-friends-add-submit"
          data-testid="friends-add-submit"
          onClick={onSubmit}
          disabled={!canSubmit}
        >
          {busy ? "…" : "send request"}
        </button>
      </div>
      {error && (
        <div class="chalk-friends-error" data-testid="friends-add-error">
          {error}
        </div>
      )}

      {/* 59-1: everyone on this server, addable in one click. */}
      <section class="chalk-friends-directory" data-testid="friends-directory">
        <h4 class="chalk-friends-section-title">everyone on this server</h4>
        {dirError && (
          <div class="chalk-friends-error" data-testid="friends-directory-error">
            couldn't load the user list: {dirError}
          </div>
        )}
        {!dirError && directory === null && (
          <div class="chalk-friends-empty">loading…</div>
        )}
        {directory !== null && directory.length === 0 && (
          <div class="chalk-friends-empty" data-testid="friends-directory-empty">
            nobody else is on this server yet
          </div>
        )}
        {directory !== null && directory.length > 0 && (
          <ul class="chalk-friends-list">
            {directory.map((u) => {
              const status = directoryStatus(
                u.user_id, friends, pendingIncoming, pendingOutgoing
              );
              return (
                <li
                  key={u.user_id}
                  class="chalk-friends-row"
                  data-testid="friends-directory-row"
                >
                  <span class="chalk-friends-handle">
                    @{u.username}
                    {u.display_name && u.display_name !== u.username && (
                      <span class="chalk-friends-dim"> {u.display_name}</span>
                    )}
                  </span>
                  <span class="chalk-friends-row-actions">
                    {status !== null ? (
                      <span class="chalk-friends-dim" data-testid="friends-directory-status">
                        {status}
                      </span>
                    ) : (
                      <button
                        type="button"
                        class="chalk-friends-action chalk-friends-action--accept"
                        data-testid="friends-directory-add"
                        onClick={() => onAddUser(u.user_id)}
                        disabled={pendingActionUserID === u.user_id}
                      >add</button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

// ---- "pending" tab -----------------------------------------------------

function PendingTab(props: {
  incoming: Friend[];
  outgoing: Friend[];
  pendingActionUserID: string | null;
  onAccept: (userID: string) => void;
  onDecline: (userID: string) => void;
}) {
  const { incoming, outgoing, pendingActionUserID, onAccept, onDecline } = props;
  if (incoming.length === 0 && outgoing.length === 0) {
    return (
      <div class="chalk-friends-empty" data-testid="friends-pending-empty">
        no pending requests
      </div>
    );
  }
  return (
    <div class="chalk-friends-pending" data-testid="friends-pending">
      {incoming.length > 0 && (
        <section>
          <h4 class="chalk-friends-section-title">incoming</h4>
          <ul class="chalk-friends-list">
            {incoming.map((f) => (
              <li key={f.userID} class="chalk-friends-row" data-testid="friends-pending-incoming-row">
                <span class="chalk-friends-handle">@{f.handle || f.userID.slice(-8)}</span>
                <span class="chalk-friends-row-actions">
                  <button
                    type="button"
                    class="chalk-friends-action chalk-friends-action--accept"
                    data-testid="friends-action-accept"
                    onClick={() => onAccept(f.userID)}
                    disabled={pendingActionUserID === f.userID}
                  >accept</button>
                  <button
                    type="button"
                    class="chalk-friends-action chalk-friends-action--decline"
                    data-testid="friends-action-decline"
                    onClick={() => onDecline(f.userID)}
                    disabled={pendingActionUserID === f.userID}
                  >decline</button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {outgoing.length > 0 && (
        <section>
          <h4 class="chalk-friends-section-title">outgoing</h4>
          <ul class="chalk-friends-list">
            {outgoing.map((f) => (
              <li key={f.userID} class="chalk-friends-row" data-testid="friends-pending-outgoing-row">
                <span class="chalk-friends-handle">@{f.handle || f.userID.slice(-8)}</span>
                <span class="chalk-friends-row-actions">
                  <button
                    type="button"
                    class="chalk-friends-action chalk-friends-action--decline"
                    data-testid="friends-action-cancel"
                    onClick={() => onDecline(f.userID)}
                    disabled={pendingActionUserID === f.userID}
                  >cancel</button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---- "friends" tab -----------------------------------------------------

function FriendsTab(props: {
  friends: Friend[];
  pendingActionUserID: string | null;
  onRemove: (userID: string) => void;
}) {
  const { friends, pendingActionUserID, onRemove } = props;
  // Confirm-before-remove state (local; not in reducer because it's
  // ephemeral and tied to this rendered list).
  const [confirmID, setConfirmID] = useState<string | null>(null);
  if (friends.length === 0) {
    return (
      <div class="chalk-friends-empty" data-testid="friends-list-empty">
        no friends yet. switch to the "add" tab to send a friend request.
      </div>
    );
  }
  return (
    <ul class="chalk-friends-list" data-testid="friends-list">
      {friends.map((f) => {
        const inFlight = pendingActionUserID === f.userID;
        const confirming = confirmID === f.userID;
        return (
          <li key={f.userID} class="chalk-friends-row" data-testid="friends-list-row">
            <span class="chalk-friends-handle">@{f.handle || f.userID.slice(-8)}</span>
            <span class="chalk-friends-row-actions">
              {confirming ? (
                <>
                  <button
                    type="button"
                    class="chalk-friends-action chalk-friends-action--decline"
                    data-testid="friends-action-remove-confirm"
                    onClick={() => {
                      setConfirmID(null);
                      onRemove(f.userID);
                    }}
                    disabled={inFlight}
                  >confirm</button>
                  <button
                    type="button"
                    class="chalk-friends-action"
                    data-testid="friends-action-remove-cancel"
                    onClick={() => setConfirmID(null)}
                  >cancel</button>
                </>
              ) : (
                <button
                  type="button"
                  class="chalk-friends-action chalk-friends-action--decline"
                  data-testid="friends-action-remove"
                  onClick={() => setConfirmID(f.userID)}
                  disabled={inFlight}
                >remove</button>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

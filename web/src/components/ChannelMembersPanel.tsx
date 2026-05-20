// ChannelMembersPanel: modal for viewing + managing members of an
// MLS channel. Phase 11c-2 PR 4.
//
// Three logical states the panel can be in:
//
//   1. "list" (default) -- show current members, each row may have:
//        - a [x] button to remove that member (visible iff the
//          caller is the channel creator, OR the row is the
//          caller's own row -- which becomes "leave channel"
//          styling).
//        - if the user just clicked [x], the row temporarily shows
//          inline "Remove? yes / cancel" buttons. yes triggers the
//          actual MLS Remove via the onRemove callback.
//
//   2. "add" -- the user clicked "+ add member". The panel shows a
//        FriendPicker (single-select) of friends not already in
//        the channel, plus an "add" button. Clicking add triggers
//        onAdd, which performs the MLS Add and returns control to
//        list mode on success.
//
//   3. "busy" overlay -- while an add or remove operation is in
//        flight, buttons are disabled and a "working..." indicator
//        is shown. Errors are surfaced inline.
//
// PR 4 does NOT live-update the member list for other clients;
// the server-side add/remove handlers don't fan channel_event yet
// (see 11c-1 design doc). The originator sees the change locally
// (we dispatch channel_member_added / channel_member_removed on
// success); other clients pick up the new state on next reconnect.

import { useEffect, useState } from "preact/hooks";
import type { ChannelSummary, Friend } from "../state/types";
import { FriendPicker } from "./FriendPicker";

interface Props {
  channel: ChannelSummary;
  ownUserID: string;
  friends: Friend[];
  onClose: () => void;
  /** Returns a promise that resolves on success and rejects on
   *  any server / crypto error. Panel surfaces the error inline. */
  onAdd: (targetUserID: string) => Promise<void>;
  onRemove: (targetUserID: string) => Promise<void>;
}

type Mode = "list" | "add";

export function ChannelMembersPanel({
  channel,
  ownUserID,
  friends,
  onClose,
  onAdd,
  onRemove,
}: Props) {
  const [mode, setMode] = useState<Mode>("list");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // For "list" mode: which row (if any) is showing the inline
  // "Remove? yes/cancel" confirmation.
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  // For "add" mode: which friend(s) the user has ticked in the
  // FriendPicker. We only add ONE per panel session (the server
  // authorizes one target per add_to_channel; multi-add would
  // need batching), so we use the FriendPicker in single-select.
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Escape closes the panel (and exits add-mode if in it).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (mode === "add") {
        setMode("list");
        setSelected(new Set());
        setError(null);
      } else if (confirmingRemove) {
        setConfirmingRemove(null);
        setError(null);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [mode, confirmingRemove, onClose]);

  // Who is the caller? (For permission rendering.) The server-side
  // policy: self-leave always allowed; removing OTHERS requires
  // being the channel creator.
  const isCreator = channel.createdBy === ownUserID;

  // Friends who are not already in the channel -- candidates for
  // adding. Filter by handle/uid so empty handles don't show up
  // as blank rows.
  const memberSet = new Set(channel.memberIDs);
  const addCandidates = friends.filter((f) => !memberSet.has(f.userID));

  async function handleAdd() {
    if (busy) return;
    const targets = Array.from(selected);
    if (targets.length === 0) {
      setError("pick a friend to add");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // Single-add per session (server validates one auth at a time).
      await onAdd(targets[0]);
      // Success: return to list mode. The parent will have
      // dispatched channel_member_added, so the list will show the
      // new member when re-rendered.
      setSelected(new Set());
      setMode("list");
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleRemove(targetUserID: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onRemove(targetUserID);
      setConfirmingRemove(null);
      // If the user just removed themselves, the panel should close
      // -- the caller is no longer a member of the channel.
      if (targetUserID === ownUserID) {
        onClose();
      }
    } catch (err) {
      setError(humanError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      class="chalk-modal-backdrop"
      data-testid="channel-members-panel-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        class="chalk-modal chalk-channel-members-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-members-panel-title"
        data-testid="channel-members-panel"
      >
        <header class="chalk-modal-header">
          <h2 id="channel-members-panel-title">
            {mode === "add" ? "add member" : `members of #${channel.name}`}
          </h2>
        </header>

        <div class="chalk-modal-body">
          {mode === "list" && (
            <MembersList
              channel={channel}
              ownUserID={ownUserID}
              isCreator={isCreator}
              busy={busy}
              confirmingRemove={confirmingRemove}
              onAskRemove={(uid) => {
                setError(null);
                setConfirmingRemove(uid);
              }}
              onCancelRemove={() => {
                setError(null);
                setConfirmingRemove(null);
              }}
              onConfirmRemove={handleRemove}
            />
          )}
          {mode === "add" && (
            <AddPicker
              candidates={addCandidates}
              selected={selected}
              onChange={setSelected}
            />
          )}
          {error && (
            <div
              class="chalk-channel-members-error"
              role="alert"
              data-testid="channel-members-error"
            >
              {error}
            </div>
          )}
        </div>

        <footer class="chalk-modal-footer">
          {mode === "list" && (
            <>
              <button
                type="button"
                class="chalk-button"
                onClick={onClose}
                disabled={busy}
                data-testid="channel-members-close"
              >
                close
              </button>
              <button
                type="button"
                class="chalk-button chalk-button--primary"
                onClick={() => {
                  setError(null);
                  setConfirmingRemove(null);
                  setMode("add");
                }}
                disabled={busy || addCandidates.length === 0}
                title={
                  addCandidates.length === 0
                    ? "all your friends are already in this channel"
                    : "add a friend to this channel"
                }
                data-testid="channel-members-add-button"
              >
                + add member
              </button>
            </>
          )}
          {mode === "add" && (
            <>
              <button
                type="button"
                class="chalk-button"
                onClick={() => {
                  setSelected(new Set());
                  setError(null);
                  setMode("list");
                }}
                disabled={busy}
                data-testid="channel-members-add-cancel"
              >
                cancel
              </button>
              <button
                type="button"
                class="chalk-button chalk-button--primary"
                onClick={handleAdd}
                disabled={busy || selected.size === 0}
                data-testid="channel-members-add-confirm"
              >
                {busy ? "adding..." : "add"}
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

// ---- subcomponents -------------------------------------------------

interface MembersListProps {
  channel: ChannelSummary;
  ownUserID: string;
  isCreator: boolean;
  busy: boolean;
  confirmingRemove: string | null;
  onAskRemove: (userID: string) => void;
  onCancelRemove: () => void;
  onConfirmRemove: (userID: string) => Promise<void>;
}

function MembersList({
  channel,
  ownUserID,
  isCreator,
  busy,
  confirmingRemove,
  onAskRemove,
  onCancelRemove,
  onConfirmRemove,
}: MembersListProps) {
  // Prefer the richer members[] (has handles) when present.
  // Fall back to memberIDs (handles will be empty).
  const rows = channel.members.length > 0
    ? channel.members
    : channel.memberIDs.map((id) => ({ userID: id, handle: "" }));

  return (
    <ul
      class="chalk-channel-members-list"
      data-testid="channel-members-list"
    >
      {rows.map((m) => {
        const isSelf = m.userID === ownUserID;
        const canRemove = isSelf || isCreator;
        const isConfirming = confirmingRemove === m.userID;
        const label = m.handle ? `@${m.handle}` : m.userID.slice(0, 8) + "...";
        return (
          <li
            key={m.userID}
            class="chalk-channel-members-item"
            data-testid="channel-members-item"
            data-user-id={m.userID}
            data-self={isSelf ? "true" : "false"}
          >
            <span class="chalk-channel-members-handle" title={m.userID}>
              {label}
              {isSelf && (
                <span class="chalk-channel-members-self-tag"> (you)</span>
              )}
              {m.userID === channel.createdBy && (
                <span
                  class="chalk-channel-members-creator-tag"
                  title="channel creator"
                > (creator)</span>
              )}
            </span>
            {canRemove && !isConfirming && (
              <button
                type="button"
                class="chalk-channel-members-remove"
                onClick={() => onAskRemove(m.userID)}
                disabled={busy}
                aria-label={isSelf ? "leave channel" : `remove ${label}`}
                title={isSelf ? "leave channel" : `remove ${label}`}
                data-testid="channel-members-remove"
              >
                {isSelf ? "leave" : "×"}
              </button>
            )}
            {isConfirming && (
              <span class="chalk-channel-members-confirm-row">
                <span class="chalk-channel-members-confirm-text">
                  {isSelf ? "leave channel?" : "remove?"}
                </span>
                <button
                  type="button"
                  class="chalk-button chalk-button--danger chalk-button--small"
                  onClick={() => onConfirmRemove(m.userID)}
                  disabled={busy}
                  data-testid="channel-members-remove-yes"
                >
                  {busy ? "..." : "yes"}
                </button>
                <button
                  type="button"
                  class="chalk-button chalk-button--small"
                  onClick={onCancelRemove}
                  disabled={busy}
                  data-testid="channel-members-remove-no"
                >
                  cancel
                </button>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

interface AddPickerProps {
  candidates: Friend[];
  selected: Set<string>;
  onChange: (s: Set<string>) => void;
}

function AddPicker({ candidates, selected, onChange }: AddPickerProps) {
  if (candidates.length === 0) {
    return (
      <p
        class="chalk-channel-members-empty"
        data-testid="channel-members-add-empty"
      >
        all your friends are already in this channel.
      </p>
    );
  }
  return (
    <div data-testid="channel-members-add-picker">
      <p class="chalk-channel-members-hint">
        pick a friend to add. only one at a time.
      </p>
      <FriendPicker
        friends={candidates}
        selected={selected}
        singleSelect={true}
        onChange={onChange}
      />
    </div>
  );
}

// ---- helpers -------------------------------------------------------

function humanError(err: unknown): string {
  if (err == null) return "unknown error";
  const msg = err instanceof Error ? err.message : String(err);
  // Translate server error codes into user-friendly phrasing.
  // These match the chalk server-side ErrCodeMls* constants.
  if (msg.includes("mls_already_member")) {
    return "they're already in this channel.";
  }
  if (msg.includes("mls_target_not_member")) {
    return "they're not in this channel.";
  }
  if (msg.includes("mls_not_authorized")) {
    return "only the channel creator can remove other members.";
  }
  if (msg.includes("mls_peer_no_keypackages")) {
    return "they need to log in at least once before they can be added to encrypted channels.";
  }
  if (msg.includes("mls_channel_not_encrypted")) {
    return "this isn't an encrypted channel.";
  }
  if (msg.includes("mls_stale_commit")) {
    return "another change landed first; reopen the channel and retry.";
  }
  return msg;
}

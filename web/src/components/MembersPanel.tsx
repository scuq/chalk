// MembersPanel: in-chat overlay showing the active channel's members and each
// member's encryption-key status. Phase 23e.
//
// Opened from the encryption lock in the channel header (App wires the click).
// Same overlay pattern as FriendsPanel/InvitesPanel: fixed card, click-outside
// + Escape to close.
//
// Per-member status is TWO truthful states:
//   * "has key" -- a wrapped channel key exists for that member (they can
//     unwrap + read). We can't know whether they've actually opened it.
//   * "waiting" -- no wrap exists for them yet.
//
// The data is passed in as props (App owns the ChannelCrypto instance and
// fetches the recipient set); this component is purely presentational. A
// single "re-share key to all waiting members" action wraps the channel key
// for everyone missing -- only meaningful when WE hold the key.

import { useEffect } from "preact/hooks";
import type { ChannelMember } from "../state/types";

interface Props {
  channelName: string;
  members: ChannelMember[];
  // member ids that currently have a wrapped key (the rest are "waiting")
  recipients: Set<string>;
  ownUserID: string | null;
  // whether WE hold the channel key (gates the re-share action)
  weHoldKey: boolean;
  loading: boolean;
  resharing: boolean;
  onReshare: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

export function MembersPanel({
  channelName,
  members,
  recipients,
  ownUserID,
  weHoldKey,
  loading,
  resharing,
  onReshare,
  onRefresh,
  onClose,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const sorted = [...members].sort((a, b) => a.handle.localeCompare(b.handle));
  const waitingCount = members.filter((m) => !recipients.has(m.userID)).length;

  return (
    <div class="chalk-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        class="chalk-modal-card chalk-members-panel"
        role="dialog"
        aria-label="channel members and encryption status"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="chalk-members-header">
          <div class="chalk-members-title">
            members <span class="chalk-members-chan">{channelName}</span>
          </div>
          <div class="chalk-members-header-actions">
            <button
              type="button"
              class="chalk-members-refresh"
              onClick={onRefresh}
              disabled={loading}
              aria-label="refresh key status"
              title="refresh key status"
            >
              refresh
            </button>
            <button
              type="button"
              class="chalk-modal-close"
              onClick={onClose}
              aria-label="close"
            >
              x
            </button>
          </div>
        </div>

        <div class="chalk-members-body">
          {loading ? (
            <div class="chalk-members-empty">checking key status...</div>
          ) : sorted.length === 0 ? (
            <div class="chalk-members-empty">no members</div>
          ) : (
            <ul class="chalk-members-list">
              {sorted.map((m) => {
                const hasKey = recipients.has(m.userID);
                const isYou = ownUserID != null && m.userID === ownUserID;
                return (
                  <li key={m.userID} class="chalk-members-row">
                    <span class="chalk-members-handle">
                      {m.handle}
                      {isYou && <span class="chalk-members-you"> (you)</span>}
                    </span>
                    <span
                      class={
                        "chalk-members-status " +
                        (hasKey
                          ? "chalk-members-status--has"
                          : "chalk-members-status--waiting")
                      }
                      title={
                        hasKey
                          ? "a wrapped key exists for this member"
                          : "no key wrapped for this member yet"
                      }
                    >
                      {hasKey ? "has key" : "waiting"}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div class="chalk-members-footer">
          {weHoldKey ? (
            waitingCount > 0 ? (
              <button
                type="button"
                class="chalk-members-reshare"
                onClick={onReshare}
                disabled={resharing}
              >
                {resharing
                  ? "re-sharing..."
                  : `re-share key to ${waitingCount} waiting member${waitingCount === 1 ? "" : "s"}`}
              </button>
            ) : (
              <span class="chalk-members-allset">all members have the key</span>
            )
          ) : (
            <span class="chalk-members-nokey">
              you don't hold this channel's key yet
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

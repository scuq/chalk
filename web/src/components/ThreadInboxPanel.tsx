// ThreadInboxPanel: the cross-channel list of threads worth your attention.
//
// Phase 42-8. Opened from the status bar, same overlay pattern as
// MembersPanel/FriendsPanel: fixed card, click-outside + Escape to close.
//
// WHY A PANEL AND NOT A SIDEBAR SECTION, for the record. Sidebar has two flat
// sibling sections and no collapsible-section pattern, so a third always-open
// "threads" section would compete for vertical space with friends and channels
// and could not be put away. A per-thread count would also break the deliberate
// dot-not-count decision documented at the top of Sidebar.tsx. The panel pattern
// already exists five times over, so using it invents nothing and touches
// nothing in the app's highest-traffic component.
//
// TWO GROUPS, from partitionThreadInbox:
//   needs you    -- unread AND (you took part OR you were mentioned)
//   also active  -- everything else that is alive right now
// The split lives in chat/threadinbox.ts because it is the part that is easy to
// get subtly wrong and it is worth unit-testing away from the DOM.
//
// PREVIEWS ARRIVE LATE. Rows render from metadata immediately -- channel, who
// replied, how many replies, when, unread -- because none of that is encrypted.
// The bodies are ciphertext and get decrypted per channel as each channel's key
// settles, so `lastReplyBody === undefined` means "not decrypted yet" and draws
// a skeleton. One slow or keyless channel never holds up the list.
//
// Presentational: App owns the frames, the crypto and the grouping.

import { useEffect, useMemo } from "preact/hooks";
import type { ThreadInboxRow } from "../state/types";
import { partitionThreadInbox } from "../chat/threadinbox";
import { fmtRelative } from "../chat/reltime";

interface Props {
  active: ThreadInboxRow[];
  agedUnread: ThreadInboxRow[];
  loaded: boolean;
  hasMoreActive: boolean;
  unreadTotal: number;
  windowHours: number;
  threadSeen: Record<string, number>;
  mentions: Record<string, boolean>;
  ownUserID: string | null;
  // channelID -> display name, and userID -> handle. Resolved by App, which
  // holds the channel list and the member rosters.
  channelNames: Record<string, string>;
  handles: Record<string, string>;
  onOpenThread: (channelID: string, threadID: string) => void;
  onLoadMore: () => void;
  onClose: () => void;
}

export function ThreadInboxPanel({
  active,
  agedUnread,
  loaded,
  hasMoreActive,
  unreadTotal,
  windowHours,
  threadSeen,
  mentions,
  ownUserID,
  channelNames,
  handles,
  onOpenThread,
  onLoadMore,
  onClose,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The aged-unread rows come FIRST: they are the ones the recency window would
  // otherwise have hidden, which is the whole reason the server sends them
  // separately. Both halves then get partitioned by the same rule.
  const { needsYou, alsoActive } = useMemo(
    () => partitionThreadInbox([...agedUnread, ...active], threadSeen, mentions),
    [active, agedUnread, threadSeen, mentions],
  );

  // One clock per render pass, like MessageList: a Date per row would make rows
  // in the same list disagree about "now".
  const now = new Date();

  const label = (userID?: string): string => {
    if (!userID) return "someone";
    if (ownUserID && userID === ownUserID) return "you";
    return handles[userID] ?? "someone";
  };

  const renderRow = (r: ThreadInboxRow) => {
    const mentioned = mentions[r.threadID] === true;
    return (
      <li
        key={r.threadID}
        class={`chalk-threadinbox-item${mentioned ? " chalk-threadinbox-item--mention" : ""}`}
      >
        <button
          type="button"
          class="chalk-threadinbox-row"
          onClick={() => onOpenThread(r.channelID, r.threadID)}
          data-testid={`threadinbox-row-${r.threadID}`}
        >
          <div class="chalk-threadinbox-meta">
            <span class="chalk-threadinbox-chan">
              {channelNames[r.channelID] ?? "a channel"}
            </span>
            <span class="chalk-threadinbox-sender">{label(r.lastReplySenderUserID)}</span>
            <span class="chalk-threadinbox-count">
              &#8629;&nbsp;{r.replyCount} {r.replyCount === 1 ? "reply" : "replies"}
            </span>
            <span class="chalk-threadinbox-when">{fmtRelative(r.lastReplyTS, now)}</span>
            {mentioned && <span class="chalk-threadinbox-at">@you</span>}
          </div>
          <div class="chalk-threadinbox-preview">
            {r.lastReplyDeleted ? (
              <span class="chalk-threadinbox-deleted">[message deleted]</span>
            ) : r.lastReplyBody === undefined ? (
              // Not decrypted yet -- this channel's key has not settled. Not an
              // error, and not "empty".
              <span class="chalk-threadinbox-skeleton" aria-hidden="true" />
            ) : (
              r.lastReplyBody
            )}
          </div>
        </button>
      </li>
    );
  };

  return (
    <div class="chalk-modal-backdrop" role="presentation" onClick={onClose}>
      <div
        class="chalk-modal-card chalk-threadinbox-panel"
        role="dialog"
        aria-label="threads with new replies"
        onClick={(e) => e.stopPropagation()}
      >
        <div class="chalk-threadinbox-header">
          <div class="chalk-threadinbox-title">
            active threads
            {needsYou.length > 0 && (
              <span class="chalk-sidebar-count">({needsYou.length})</span>
            )}
          </div>
          <button
            type="button"
            class="chalk-modal-close"
            onClick={onClose}
            aria-label="close"
          >
            x
          </button>
        </div>

        {!loaded ? (
          <div class="chalk-threadinbox-empty">loading&hellip;</div>
        ) : needsYou.length === 0 && alsoActive.length === 0 ? (
          <div class="chalk-threadinbox-empty">
            nothing needs you
            <div class="chalk-threadinbox-empty-hint">
              threads with a reply in the last {windowHours} hours show up here
            </div>
          </div>
        ) : (
          <>
            {needsYou.length > 0 && (
              <div class="chalk-threadinbox-section">
                <div class="chalk-sidebar-header">
                  <span>needs you</span>
                  {unreadTotal > needsYou.length && (
                    <span class="chalk-sidebar-count">
                      ({needsYou.length} of {unreadTotal})
                    </span>
                  )}
                </div>
                <ul class="chalk-sidebar-list">{needsYou.map(renderRow)}</ul>
              </div>
            )}
            {alsoActive.length > 0 && (
              <div class="chalk-threadinbox-section">
                <div class="chalk-sidebar-header">
                  <span>also active</span>
                </div>
                <ul class="chalk-sidebar-list">{alsoActive.map(renderRow)}</ul>
              </div>
            )}
            {hasMoreActive && (
              <button
                type="button"
                class="chalk-threadinbox-more"
                onClick={onLoadMore}
                data-testid="threadinbox-load-more"
              >
                load more
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

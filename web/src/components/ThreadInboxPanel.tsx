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
// AGE FADES THE ROW (47-1). Rows are already newest-first, but a sorted list
// says nothing about *how much* newer -- ten minutes and ten hours look the
// same. Opacity bands from threadAgeStep make the drop-off visible, so a live
// thread stands out from one that has been sitting there since yesterday.
//
// FILTER IS CLIENT-SIDE (47-2), and can only be: bodies are ciphertext. It sees
// the rows we hold and, per thread, every line this client has decrypted --
// App merges live pushes, loaded history and opened threads into threadLines
// (47-8). A filtered row previews the line that matched, not just the newest
// reply, so a hit inside a thread explains itself. See chat/threadinbox.ts.
//
// Presentational: App owns the frames, the crypto and the grouping.

import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ThreadInboxRow } from "../state/types";
import {
  bestMatchLine,
  isThreadUnread,
  partitionThreadInbox,
  threadAgeStep,
  threadQueryTerms,
  threadRowMatches,
  type ThreadLine,
} from "../chat/threadinbox";
import { fmtRelative } from "../chat/reltime";
import { threadTitle } from "../chat/threadtitle";

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
  // threadID -> every decrypted line this client holds for that thread,
  // newest-first with the head last. What the filter actually searches (47-8).
  threadLines: Record<string, ThreadLine[]>;
  onOpenThread: (channelID: string, threadID: string) => void;
  // 45-3: clear the rows listed here without opening them. Gets exactly the
  // rows the button was offered for, so what it marks is what was on screen --
  // including while filtering.
  onMarkAllRead: (rows: ThreadInboxRow[]) => void;
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
  threadLines,
  onOpenThread,
  onMarkAllRead,
  onLoadMore,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape backs out one level at a time: it clears the filter first, so a
      // mistyped query does not also cost you the panel.
      if (query.length > 0) {
        setQuery("");
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, query]);

  // One clock per render pass, like MessageList: a Date per row would make rows
  // in the same list disagree about "now".
  const now = new Date();

  const label = (userID?: string): string => {
    if (!userID) return "someone";
    if (ownUserID && userID === ownUserID) return "you";
    return handles[userID] ?? "someone";
  };

  const terms = useMemo(() => threadQueryTerms(query), [query]);

  // The aged-unread rows come FIRST: they are the ones the recency window would
  // otherwise have hidden, which is the whole reason the server sends them
  // separately.
  const rows = useMemo(() => {
    const all = [...agedUnread, ...active];
    if (terms.length === 0) return all;
    return all.filter((r) =>
      threadRowMatches(
        [
          channelNames[r.channelID] ?? "",
          label(r.lastReplySenderUserID),
          label(r.headSenderUserID),
          // 47-8: every line this client holds for the thread, plus who wrote
          // it -- so "alice deploy" finds alice's reply deep in the thread,
          // not just the two previews a row carries.
          ...(threadLines[r.threadID] ?? []).flatMap((l) => [
            l.senderUserID ? label(l.senderUserID) : "",
            l.body,
          ]),
        ].join(" "),
        terms,
      ),
    );
  }, [active, agedUnread, terms, channelNames, handles, ownUserID, threadLines]);

  // Both halves get partitioned by the same rule.
  const { needsYou, alsoActive } = useMemo(
    () => partitionThreadInbox(rows, threadSeen, mentions),
    [rows, threadSeen, mentions],
  );

  // 45-3: every listed row with an unread reply, in both groups -- "mark all
  // read" is about the badge, and the badge doesn't care which group a thread
  // landed in.
  const unreadRows = useMemo(
    () => rows.filter((r) => isThreadUnread(r, threadSeen)),
    [rows, threadSeen],
  );

  const filtering = terms.length > 0;

  const renderRow = (r: ThreadInboxRow) => {
    const mentioned = mentions[r.threadID] === true;
    const lines = threadLines[r.threadID] ?? [];
    // While filtering, preview the line that matched -- an older reply or the
    // head would otherwise leave the row looking like a false positive. -1
    // means the match was channel/sender metadata; keep the normal preview.
    const matchIdx = filtering ? bestMatchLine(lines.map((l) => l.body), terms) : -1;
    const matched = matchIdx >= 0 ? lines[matchIdx] : undefined;
    // When the row's own preview has not decrypted yet but this client already
    // holds the newest reply (thread open, or the reply came in live), show
    // that instead of a skeleton.
    const fallback = lines.find((l) => !l.head);
    // 49-1: the thread's title -- its head message. The row's own preview
    // decrypts per channel; until then a head line this client already holds
    // (thread opened, or the head is in loaded history) fills in. headKnown
    // separates "still decrypting" (skeleton) from "known but empty"
    // (attachment-only head: drop the line rather than pulse forever).
    const headLine = lines.find((l) => l.head);
    const headTitle = threadTitle(r.headBody ?? headLine?.body);
    const headKnown =
      r.headBody !== undefined || headLine !== undefined || r.headDeleted === true;
    return (
      <li
        key={r.threadID}
        class={`chalk-threadinbox-item${mentioned ? " chalk-threadinbox-item--mention" : ""}`}
      >
        <button
          type="button"
          class="chalk-threadinbox-row"
          data-age={threadAgeStep(r.lastReplyTS, now)}
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
          {r.headDeleted ? (
            <div class="chalk-threadinbox-headline">
              <span class="chalk-threadinbox-deleted">[message deleted]</span>
            </div>
          ) : !headKnown ? (
            <div class="chalk-threadinbox-headline">
              <span class="chalk-threadinbox-skeleton" aria-hidden="true" />
            </div>
          ) : headTitle !== null ? (
            <div class="chalk-threadinbox-headline">{headTitle}</div>
          ) : null}
          <div class="chalk-threadinbox-preview">
            {matched ? (
              <>
                {matched.senderUserID && (
                  <span class="chalk-threadinbox-preview-sender">
                    {label(matched.senderUserID)}:{" "}
                  </span>
                )}
                {matched.body}
              </>
            ) : r.lastReplyDeleted ? (
              <span class="chalk-threadinbox-deleted">[message deleted]</span>
            ) : (r.lastReplyBody ?? fallback?.body) === undefined ? (
              // Not decrypted yet -- this channel's key has not settled. Not an
              // error, and not "empty".
              <span class="chalk-threadinbox-skeleton" aria-hidden="true" />
            ) : (
              r.lastReplyBody ?? fallback?.body
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
          <div class="chalk-threadinbox-actions">
            {unreadRows.length > 0 && (
              <button
                type="button"
                class="chalk-threadinbox-markall"
                onClick={() => onMarkAllRead(unreadRows)}
                title={
                  filtering
                    ? `mark the ${unreadRows.length} matching ${unreadRows.length === 1 ? "thread" : "threads"} read`
                    : "mark every thread listed here read"
                }
                data-testid="threadinbox-mark-all-read"
              >
                mark all read
              </button>
            )}
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

        <div class="chalk-threadinbox-search">
          <input
            ref={inputRef}
            type="text"
            class="chalk-threadinbox-input"
            placeholder="filter threads..."
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            aria-label="filter threads by channel, sender or message text"
            data-testid="threadinbox-search"
          />
          {filtering && (
            <button
              type="button"
              class="chalk-threadinbox-clear"
              onClick={() => {
                setQuery("");
                inputRef.current?.focus();
              }}
              aria-label="clear filter"
            >
              x
            </button>
          )}
        </div>

        {!loaded ? (
          <div class="chalk-threadinbox-empty">loading&hellip;</div>
        ) : needsYou.length === 0 && alsoActive.length === 0 ? (
          <div class="chalk-threadinbox-empty">
            {filtering ? "no threads match" : "nothing needs you"}
            <div class="chalk-threadinbox-empty-hint">
              {filtering ? (
                // Being explicit beats letting someone conclude the thread is
                // gone: what is searchable here is only what this client holds.
                <>
                  the filter matches the channel, who wrote, and every message
                  of a thread this device has seen &mdash; replies never loaded
                  here can't be searched
                </>
              ) : (
                <>threads with a reply in the last {windowHours} hours show up here</>
              )}
            </div>
          </div>
        ) : (
          <>
            {needsYou.length > 0 && (
              <div class="chalk-threadinbox-section">
                <div class="chalk-sidebar-header">
                  <span>needs you</span>
                  {/* Suppressed while filtering: "3 of 40" would be comparing a
                      filtered count against the unfiltered server total. */}
                  {!filtering && unreadTotal > needsYou.length && (
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

// Zuckermode's home screen (62-6): one list of every conversation, DMs and
// channels mixed, newest activity first, each row previewing the last
// message. Presentational only -- rows arrive pre-built from
// buildConversationList (chat/zucker.ts), navigation lives in App.
//
// The pinned rows above the list keep the two non-conversation surfaces the
// classic drawer carried (parking lot, thread inbox); the header buttons
// keep its two "+" entry points. 64-1 adds a third pinned row: friends,
// expanding in place to the full roster with presence, because the
// activity-sorted list buries anyone you haven't talked to lately.

import { useLayoutEffect, useRef, useState } from "preact/hooks";
import type { ZuckerFriend, ZuckerRow } from "../chat/zucker";
import type { PresenceMap } from "../state/types";
import { filterRoster } from "../chat/roster-filter";
import { fmtRelative } from "../chat/reltime";
import { UnreadDot } from "./UnreadDot";
import { ChannelGlyph, presenceClass, presenceLabel } from "./Sidebar";

interface Props {
  rows: ZuckerRow[];
  // 78-3: conversations this user has hidden from their roster (the sidebar
  // menu is where that happens). Held behind a "hidden" row under the list
  // so the two views agree about what the roster looks like.
  hiddenRows?: ZuckerRow[];
  presence: PresenceMap;
  friends: ZuckerFriend[];
  // null hides the row (prefs.parkingLot.hidden), mirroring the sidebar.
  parkingName: string | null;
  threadsUnread: number;
  onSelect: (channelID: string) => void;
  onFriendSelect: (userID: string) => void;
  onPark: () => void;
  onOpenThreads: () => void;
  onAddFriend: () => void;
  onCreateChannel: () => void;
}

export function ZuckerList({
  rows,
  hiddenRows = [],
  presence,
  friends,
  parkingName,
  threadsUnread,
  onSelect,
  onFriendSelect,
  onPark,
  onOpenThreads,
  onAddFriend,
  onCreateChannel,
}: Props) {
  const [friendsOpen, setFriendsOpen] = useState(false);
  // 64-2/64-5: quick filter over the conversation rows, same match rule as
  // the sidebar's rosters (54-1). Hidden behind the header's magnifier
  // toggle; closing it clears the query so no invisible filter lingers.
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  // Layout effect: focus at commit, before paint, so opening the filter
  // never shows an unfocused field first.
  useLayoutEffect(() => {
    if (filterOpen) filterRef.current?.focus();
  }, [filterOpen]);
  const visibleRows = filterRoster(rows, filter, (r) => r.name);
  const onlineCount = friends.filter((f) => f.presence === "online").length;
  // 78-3: the hidden shelf. Open state is component state, like the
  // sidebar's: a peek, not a setting.
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const shownHidden = filterRoster(hiddenRows, filter, (r) => r.name);
  const hiddenUnread = hiddenRows.some((r) => r.unread);
  const hiddenMention = hiddenRows.some((r) => r.unread && r.mention);
  // One clock per render, the MessageList precedent: a list of relative
  // times must agree with itself.
  const now = new Date();

  const conversationRow = (r: ZuckerRow, hidden: boolean) => (
    <li key={r.id}>
      <button
        type="button"
        class={`chalk-zucker-row ${hidden ? "chalk-zucker-row--hidden" : ""}`}
        onClick={() => onSelect(r.id)}
        data-testid="zucker-row"
        data-channel-id={r.id}
        data-hidden={hidden ? "true" : "false"}
      >
        <span class="chalk-zucker-row-badge">
          {r.isDM ? (
            <span
              class={`chalk-presence-dot ${presenceClass(
                r.otherUserID !== null ? presence[r.otherUserID] : undefined,
              )}`}
              title={presenceLabel(
                r.otherUserID !== null ? presence[r.otherUserID] : undefined,
              )}
            />
          ) : (
            <ChannelGlyph type={r.isVoice ? "voice" : "text"} />
          )}
        </span>
        <span class="chalk-zucker-row-main">
          <span class="chalk-zucker-row-top">
            <span class="chalk-zucker-row-name">{r.name}</span>
            <span class="chalk-zucker-row-when">
              {fmtRelative(new Date(r.when), now)}
            </span>
          </span>
          <span class="chalk-zucker-row-preview">
            {r.preview !== null ? (
              <>
                {r.previewSender !== null && (
                  <span class="chalk-zucker-row-sender">{r.previewSender}: </span>
                )}
                {r.preview}
              </>
            ) : (
              <span class="chalk-zucker-row-empty">
                {r.isVoice ? "voice room" : "no messages yet"}
              </span>
            )}
          </span>
        </span>
        {r.unread && <UnreadDot mention={r.mention} />}
      </button>
    </li>
  );

  return (
    <div class="chalk-zucker" data-testid="zucker-list">
      <div class="chalk-zucker-head">
        <span class="chalk-zucker-title">conversations</span>
        <button
          type="button"
          class={`chalk-zucker-add ${filterOpen ? "chalk-zucker-add--active" : ""}`}
          onClick={() => {
            if (filterOpen) setFilter("");
            setFilterOpen(!filterOpen);
          }}
          title="filter conversations"
          aria-label="filter conversations"
          aria-pressed={filterOpen}
          data-testid="zucker-filter-toggle"
        >
          ⌕
        </button>
        <button
          type="button"
          class="chalk-zucker-add"
          onClick={onAddFriend}
          title="add a friend"
          aria-label="add a friend"
          data-testid="zucker-add-friend"
        >
          @+
        </button>
        <button
          type="button"
          class="chalk-zucker-add"
          onClick={onCreateChannel}
          title="new channel"
          aria-label="new channel"
          data-testid="zucker-new-channel"
        >
          +
        </button>
      </div>

      {parkingName !== null && (
        <button
          type="button"
          class="chalk-zucker-pinned"
          onClick={onPark}
          data-testid="zucker-parking"
        >
          {parkingName}
        </button>
      )}
      <button
        type="button"
        class="chalk-zucker-pinned"
        onClick={() => setFriendsOpen(!friendsOpen)}
        aria-expanded={friendsOpen}
        data-testid="zucker-friends"
      >
        <span>@ friends</span>
        <span class="chalk-zucker-pinned-note">
          {onlineCount}/{friends.length} online
        </span>
      </button>
      {friendsOpen && (
        <ul class="chalk-zucker-friends" data-testid="zucker-friends-list">
          {friends.length === 0 && (
            <li class="chalk-zucker-friends-empty">no friends yet</li>
          )}
          {friends.map((f) => (
            <li key={f.userID}>
              <button
                type="button"
                class="chalk-zucker-friend"
                onClick={() => onFriendSelect(f.userID)}
                data-testid="zucker-friend"
                data-user-id={f.userID}
                data-presence={f.presence}
              >
                <span
                  class={`chalk-presence-dot ${presenceClass(f.presence)}`}
                  aria-label={presenceLabel(f.presence)}
                />
                <span class="chalk-zucker-friend-name">{f.name}</span>
                <span class="chalk-zucker-friend-state">{f.presence}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        class="chalk-zucker-pinned"
        onClick={onOpenThreads}
        data-testid="zucker-threads"
      >
        <span>↳ threads</span>
        {threadsUnread > 0 && <UnreadDot mention={false} />}
      </button>

      {filterOpen && (
        <div class="chalk-zucker-filter">
          <input
            type="text"
            class="chalk-sidebar-filter-input"
            data-testid="zucker-filter"
            placeholder="filter…"
            value={filter}
            ref={filterRef}
            onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
            aria-label="filter conversations"
          />
        </div>
      )}

      <ul class="chalk-zucker-rows" data-testid="zucker-rows">
        {rows.length > 0 && visibleRows.length === 0 && (
          <li class="chalk-zucker-friends-empty">no matches</li>
        )}
        {visibleRows.map((r) => conversationRow(r, false))}
      </ul>

      {hiddenRows.length > 0 && (
        <>
          <button
            type="button"
            class="chalk-zucker-pinned"
            onClick={() => setHiddenOpen(!hiddenOpen)}
            aria-expanded={hiddenOpen}
            data-testid="zucker-hidden-toggle"
            data-open={hiddenOpen ? "true" : "false"}
          >
            <span>{hiddenOpen ? "▾" : "▸"} hidden</span>
            <span class="chalk-zucker-pinned-note">{hiddenRows.length}</span>
            {/* Hiding is not muting: a hidden conversation that needs you
                still says so from behind the row. */}
            {hiddenUnread && <UnreadDot mention={hiddenMention} />}
          </button>
          {hiddenOpen && (
            <ul class="chalk-zucker-rows" data-testid="zucker-hidden-rows">
              {shownHidden.map((r) => conversationRow(r, true))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

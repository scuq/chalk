// Sidebar: roster (friends) + group-channels list + new-channel button.
// Phase 9.6c: presence dots, @ prefix dropped from sidebar roster.

import { useState } from "preact/hooks";
import type { ChannelSummary, Friend, PresenceMap } from "../state/types";

interface Props {
  channels: ChannelSummary[];
  friends: Friend[];
  activeID: string | null;
  ownUserID: string | null;
  // Phase 9.6c: presence state, keyed by friend user_id. Absent or
  // "offline" → hollow dot. "online" → green. "away" → yellow.
  presence: PresenceMap;
  onSelect: (channelID: string) => void;
  onFriendClick: (friendUserID: string) => void;
  onCreateClick: () => void;
}

// Show the filter input above the friends list only when the roster
// has at least this many entries. Below the threshold the input
// would be clutter (you can scan a 1-6 friend list at a glance).
const FRIEND_FILTER_THRESHOLD = 7;

function sortFriends(friends: Friend[]): Friend[] {
  return [...friends].sort((a, b) => {
    if (a.handle && !b.handle) return -1;
    if (!a.handle && b.handle) return 1;
    return a.handle.localeCompare(b.handle);
  });
}

function findDMWithFriend(
  channels: ChannelSummary[],
  friendUserID: string,
  ownUserID: string | null
): ChannelSummary | null {
  if (!ownUserID) return null;
  for (const ch of channels) {
    if (!ch.isDM) continue;
    if (ch.memberIDs.length !== 2) continue;
    const otherID = ch.memberIDs.find((id) => id !== ownUserID);
    if (otherID === friendUserID) return ch;
  }
  return null;
}

// Phase 9.6c: map state string to a CSS modifier class. "online" →
// solid green; "away" → solid yellow; everything else (including
// missing entries) → hollow grey.
function presenceClass(state: string | undefined): string {
  if (state === "online") return "chalk-presence-dot--online";
  if (state === "away") return "chalk-presence-dot--away";
  return "chalk-presence-dot--offline";
}

function presenceLabel(state: string | undefined): string {
  if (state === "online") return "online";
  if (state === "away") return "away";
  return "offline";
}

export function Sidebar({
  channels,
  friends,
  activeID,
  ownUserID,
  presence,
  onSelect,
  onFriendClick,
  onCreateClick,
}: Props) {
  const [filter, setFilter] = useState("");

  const groupChannels = channels.filter((ch) => !ch.isDM);
  const sortedFriends = sortFriends(friends);

  const trimmedFilter = filter.trim().toLowerCase();
  const visibleFriends = trimmedFilter
    ? sortedFriends.filter((f) =>
        (f.handle || f.userID).toLowerCase().includes(trimmedFilter)
      )
    : sortedFriends;

  const showFilter = sortedFriends.length >= FRIEND_FILTER_THRESHOLD;

  return (
    <div class="chalk-sidebar-inner" data-testid="sidebar">

      {/* ---- friends section ---- */}
      <div class="chalk-sidebar-section chalk-sidebar-section--friends">
        <div class="chalk-sidebar-header">
          <span class="chalk-sidebar-title">
            friends {sortedFriends.length > 0 && (
              <span class="chalk-sidebar-count">({sortedFriends.length})</span>
            )}
          </span>
        </div>

        {showFilter && (
          <div class="chalk-sidebar-filter">
            <input
              type="text"
              class="chalk-sidebar-filter-input"
              data-testid="sidebar-friends-filter"
              placeholder="filter…"
              value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
              aria-label="filter friends"
            />
          </div>
        )}

        <ul
          class="chalk-sidebar-list chalk-sidebar-list--friends"
          data-testid="sidebar-friends-list"
        >
          {sortedFriends.length === 0 && (
            <li class="chalk-sidebar-empty">no friends yet</li>
          )}
          {sortedFriends.length > 0 && visibleFriends.length === 0 && (
            <li class="chalk-sidebar-empty">no matches</li>
          )}
          {visibleFriends.map((friend) => {
            const dm = findDMWithFriend(channels, friend.userID, ownUserID);
            const isActive = dm !== null && dm.id === activeID;
            const presenceState = presence[friend.userID];
            const dotClass = presenceClass(presenceState);
            const dotLabel = presenceLabel(presenceState);
            const displayName = friend.handle || friend.userID.slice(-8);
            return (
              <li
                key={friend.userID}
                class={`chalk-sidebar-item chalk-sidebar-item--friend ${isActive ? "chalk-sidebar-item--active" : ""}`}
                data-testid="sidebar-friend-item"
                data-friend-id={friend.userID}
                data-active={isActive ? "true" : "false"}
                data-presence={presenceState ?? "offline"}
                onClick={() => onFriendClick(friend.userID)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onFriendClick(friend.userID);
                  }
                }}
                title={dm ? `${displayName} — ${dotLabel}` : `${displayName} — ${dotLabel} — start chat`}
              >
                {/* Always-rendered dot column for consistent alignment. */}
                <span
                  class={`chalk-presence-dot ${dotClass}`}
                  aria-label={dotLabel}
                />
                <span class="chalk-sidebar-item-name">
                  {displayName}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* ---- channels section ---- */}
      <div class="chalk-sidebar-section chalk-sidebar-section--channels">
        <div class="chalk-sidebar-header chalk-sidebar-header--channels">
          <span class="chalk-sidebar-title">
            channels {groupChannels.length > 0 && (
              <span class="chalk-sidebar-count">({groupChannels.length})</span>
            )}
          </span>
          <button
            class="chalk-sidebar-new"
            type="button"
            data-testid="sidebar-new"
            onClick={onCreateClick}
            aria-label="new channel"
            title="new channel"
          >+</button>
        </div>
        <ul
          class="chalk-sidebar-list chalk-sidebar-list--channels"
          data-testid="sidebar-list"
        >
          {groupChannels.length === 0 && (
            <li class="chalk-sidebar-empty">no channels yet</li>
          )}
          {groupChannels.map((ch) => (
            <li
              key={ch.id}
              class={`chalk-sidebar-item ${ch.id === activeID ? "chalk-sidebar-item--active" : ""}`}
              data-testid="sidebar-item"
              data-channel-id={ch.id}
              data-active={ch.id === activeID ? "true" : "false"}
              onClick={() => onSelect(ch.id)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(ch.id);
                }
              }}
            >
              <span class="chalk-sidebar-item-name">#{ch.name}</span>
            </li>
          ))}
        </ul>
      </div>

    </div>
  );
}

// Sidebar: roster (friends) + group-channels list + new-channel button.
// Phase 9.6c: presence dots, @ prefix dropped from sidebar roster.
// Phase 30 (30-5): Discord-style channel rows. Text channels carry a "❯"
// prompt glyph (the terminal aesthetic's answer to "#"); voice channels
// carry "▶" plus a LIVE occupant sublist -- who is in the room right now,
// with mute / camera / screen badges, visible without entering the channel.
// Occupancy is reducer-owned (voiceRosters): seeded by a voice_roster
// request per voice channel after the channel list loads, kept current by
// joined/left/state pushes.

import { useState } from "preact/hooks";
import type {
  ChannelSummary,
  Friend,
  PresenceMap,
  VoiceParticipant,
} from "../state/types";

// Channel-kind indicators (30-5d): inline SVGs in currentColor, replacing
// the 30-5 UTF-8 glyphs (❯ / ▶) whose weight and baseline vary across
// monospace fonts. Same stroke family as the occupant badges below, so the
// whole sidebar reads as one icon set. Text = a terminal prompt (chevron +
// cursor underscore -- chalk's answer to Discord's "#"); voice = a speaker
// with waves (the play triangle read as "media playback", not "room").
export function ChannelGlyph({ type }: { type: "text" | "voice" }) {
  return type === "voice" ? <VoiceChannelIcon /> : <TextChannelIcon />;
}

function TextChannelIcon() {
  // 30-5f: a speech bubble with two text lines. Reads as "messages"
  // directly, and doesn't collide with the terminal ">_" prompt used
  // elsewhere in the app. Pairs naturally with the voice speaker.
  return (
    <svg
      class="chalk-chglyph-svg"
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-label="text channel"
      role="img"
    >
      <path d="M4 5h16v11H9l-4 3v-3H4z" />
      <line x1="7.5" y1="9" x2="16.5" y2="9" />
      <line x1="7.5" y1="12.5" x2="13" y2="12.5" />
    </svg>
  );
}

function VoiceChannelIcon() {
  return (
    <svg
      class="chalk-chglyph-svg"
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      stroke-width="2.2"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-label="voice channel"
      role="img"
    >
      <path d="M4 9v6h4l5 4V5L8 9H4z" />
      <path d="M15.5 8.5a5 5 0 0 1 0 7" />
      <path d="M18.5 6a9 9 0 0 1 0 12" />
    </svg>
  );
}

interface Props {
  channels: ChannelSummary[];
  friends: Friend[];
  activeID: string | null;
  ownUserID: string | null;
  // Phase 9.6c: presence state, keyed by friend user_id. Absent or
  // "offline" → hollow dot. "online" → green. "away" → yellow.
  presence: PresenceMap;
  // 30-5: live voice-room occupancy by channel id (reducer-owned).
  voiceRosters: Record<string, VoiceParticipant[]>;
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

// 30-5: resolve an occupant's display name from the channel's member list.
// "you" for the viewer's own entry -- seeing yourself listed in the room
// from the sidebar is the Discord behavior and doubles as join feedback.
function occupantName(
  ch: ChannelSummary,
  ownUserID: string | null,
  userID: string
): string {
  if (ownUserID && userID === ownUserID) return "you";
  const m = (ch.members ?? []).find((x) => x.userID === userID);
  return m?.handle || userID.slice(0, 8);
}

// ---- 30-5 badge icons -------------------------------------------------------
// Tiny inline SVGs in currentColor so they inherit the theme (the emoji
// variants 🔇/🎥 fight the green-on-black palette). Stroke style, 12px box.

function MicOffIcon() {
  return (
    <svg
      class="chalk-voice-badge chalk-voice-badge--muted"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      aria-label="muted"
      role="img"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <line x1="12" y1="18" x2="12" y2="21" />
      <line x1="3" y1="3" x2="21" y2="21" />
    </svg>
  );
}

function CamIcon() {
  return (
    <svg
      class="chalk-voice-badge chalk-voice-badge--cam"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-label="camera on"
      role="img"
    >
      <rect x="2" y="6" width="13" height="12" rx="2" />
      <path d="M15 10l7-4v12l-7-4z" />
    </svg>
  );
}

function ScreenIcon() {
  return (
    <svg
      class="chalk-voice-badge chalk-voice-badge--screen"
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      stroke-width="2.4"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-label="sharing screen"
      role="img"
    >
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

export function Sidebar({
  channels,
  friends,
  activeID,
  ownUserID,
  presence,
  voiceRosters,
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
          {groupChannels.map((ch) => {
            const isVoice = ch.channelType === "voice";
            const roster = isVoice ? (voiceRosters[ch.id] ?? []) : [];
            return (
              <li
                key={ch.id}
                class={`chalk-sidebar-item ${isVoice ? "chalk-sidebar-item--voicech" : ""} ${ch.id === activeID ? "chalk-sidebar-item--active" : ""}`}
                data-testid="sidebar-item"
                data-channel-id={ch.id}
                data-channel-type={isVoice ? "voice" : "text"}
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
                <span class="chalk-sidebar-item-row">
                  <span
                    class={`chalk-chglyph ${isVoice ? "chalk-chglyph--voice" : "chalk-chglyph--text"}`}
                  >
                    <ChannelGlyph type={isVoice ? "voice" : "text"} />
                  </span>
                  <span class="chalk-sidebar-item-name">{ch.name}</span>
                  {isVoice && roster.length > 0 && (
                    <span
                      class="chalk-sidebar-voicecount"
                      data-testid="sidebar-voice-count"
                      title={`${roster.length} in voice`}
                    >
                      {roster.length}
                    </span>
                  )}
                </span>
                {/* 30-5: live occupant sublist. Rendered inside the channel
                    <li> (still one click target); pointer events fall through
                    to the channel select. */}
                {isVoice && roster.length > 0 && (
                  <ul
                    class="chalk-sidebar-occupants"
                    data-testid="sidebar-voice-occupants"
                  >
                    {roster.map((p) => (
                      <li
                        class="chalk-sidebar-occupant"
                        key={p.userID + ":" + p.deviceID}
                        data-user-id={p.userID}
                      >
                        <span class="chalk-sidebar-occupant-name">
                          {occupantName(ch, ownUserID, p.userID)}
                        </span>
                        {p.muted && <MicOffIcon />}
                        {p.videoOn && <CamIcon />}
                        {p.screenOn && <ScreenIcon />}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>

    </div>
  );
}

// Sidebar: roster (friends) + group-channels list + new-channel button.
// Phase 9.6c: presence dots, @ prefix dropped from sidebar roster.
// Phase 30 (30-5): Discord-style channel rows. Text channels carry a "❯"
// prompt glyph (the terminal aesthetic's answer to "#"); voice channels
// carry "▶" plus a LIVE occupant sublist -- who is in the room right now,
// with mute / camera / screen badges, visible without entering the channel.
// Occupancy is reducer-owned (voiceRosters): seeded by a voice_roster
// request per voice channel after the channel list loads, kept current by
// joined/left/state pushes.

import { useState, useRef, useEffect } from "preact/hooks";
import {
  DEFAULT_SELF_HUE,
  hexFromHue,
  hueFromHex,
  nickTintStyle,
} from "../chat/nickcolor";
import { PrioritySelect } from "./PrioritySelect";
import { filterRoster, showRosterFilter } from "../chat/roster-filter";
import {
  DEFAULT_GROUP,
  canonicalizeGroup,
  effectiveGroup,
  groupRoster,
  knownGroups,
  loadCollapsedGroups,
  saveCollapsedGroups,
} from "../chat/channel-groups";
import type { RosterGroup } from "../chat/channel-groups";
import { withChannelRule, withUserRule } from "../notify/rules";
import { useRulesConfig } from "../notify/rules-store";
import { countsAsUnread, hasUnread } from "../state/types";
import type {
  ChannelSummary,
  ChannelUnread,
  Friend,
  PresenceMap,
  VoiceParticipant,
} from "../state/types";

// 33-2: the unread marker. Deliberately a dot and not a count -- the
// sidebar's job is "something happened here", and a number invites reading
// the sidebar instead of the channel. The mention variant is the same shape
// in the accent color: same glance, louder answer.
function UnreadDot({ mention }: { mention: boolean }) {
  const label = mention ? "unread, you were mentioned" : "unread messages";
  return (
    <span
      class={`chalk-unread-dot ${mention ? "chalk-unread-dot--mention" : ""}`}
      data-testid={mention ? "sidebar-mention-dot" : "sidebar-unread-dot"}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}

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

// 53-1: the parking lot's row icon. An eye with a line through it -- the row
// can be renamed to anything, so the glyph has to carry the meaning on its
// own: what's here is what isn't shown. Same stroke family as the rest.
function ParkingIcon() {
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
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z" />
      <circle cx="12" cy="12" r="2.6" />
      <line x1="3" y1="21" x2="21" y2="3" />
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
  // 33-2: unread + mention state by channel id (reducer-owned). Missing
  // entry means "nothing unread".
  unread: Record<string, ChannelUnread>;
  onSelect: (channelID: string) => void;
  onFriendClick: (friendUserID: string) => void;
  // Phase 9.7f: nick colors. hueForHandle resolves the color a handle
  // currently renders in (explicit pick or auto hash), or null for none --
  // including when the master switch is off, so callers can tint on its
  // result alone. onSetFriendHue persists a pick, or clears it back to
  // automatic when passed null. All optional so other Sidebar callers are
  // unaffected.
  nickColorsEnabled?: boolean;
  hueForHandle?: (handle: string) => number | null;
  // 47-5: the viewer's own color, for rows that render as "you" (voice
  // occupants). null when coloring is off.
  selfHue?: number | null;
  onSetFriendHue?: (handle: string, hue: number | null) => void;
  onCreateClick: () => void;
  // 59-1: the friends header's "+" — opens the add-friend flow (the
  // friends panel on its "add" tab, which lists everyone on the
  // server). Optional so other Sidebar callers are unaffected.
  onAddFriendClick?: () => void;
  // 54-3: render the channels section grouped by each channel's group name.
  // Headers only appear once a second group exists -- an all-'General'
  // roster looks exactly like the ungrouped one.
  groupingEnabled?: boolean;
  // 54-4: this user's channel id -> group overrides (resolved prefs), and
  // the setter behind the context menu's group row. null group = back to
  // the creator's suggestion. Optional so other Sidebar callers are
  // unaffected; the menu row only renders when the setter is provided.
  groupOverrides?: Record<string, string>;
  onSetChannelGroup?: (channelID: string, group: string | null) => void;
  // 53-1: the parking lot. A pseudo-channel that shows nothing -- one click
  // and the conversation pane is a logo. null hides the row (the setting), and
  // parked highlights it the way an open channel is highlighted.
  parkingName?: string | null;
  parked?: boolean;
  onPark?: () => void;
  // 49-6: the thread-inbox entry point, relocated here from the status bar so
  // every unread dot lives in the sidebar. threadsUnread is a COUNT but
  // renders as a dot -- same call as the channel rows.
  onOpenThreads?: () => void;
  threadsUnread?: number;
}

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

// 47-5: the handle an occupant colors by, or "" when the channel's member
// list doesn't name them (the row falls back to a userID slice, which has no
// stable identity to color).
function occupantHandle(ch: ChannelSummary, userID: string): string {
  return (ch.members ?? []).find((x) => x.userID === userID)?.handle || "";
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
  unread,
  onSelect,
  onFriendClick,
  nickColorsEnabled,
  hueForHandle,
  selfHue,
  onSetFriendHue,
  onCreateClick,
  onAddFriendClick,
  groupingEnabled = true,
  groupOverrides,
  onSetChannelGroup,
  parkingName,
  parked = false,
  onPark,
  onOpenThreads,
  threadsUnread = 0,
}: Props) {
  const [filter, setFilter] = useState("");
  // 54-1: the channels list gets the same filter treatment as friends.
  // Separate state -- each input appears only when its own list is long.
  const [channelFilter, setChannelFilter] = useState("");

  const groupChannels = channels.filter((ch) => !ch.isDM);
  // 53-1: the active channel is still pointed at while parked, but it isn't on
  // screen -- so no row claims to be the one you are reading.
  const activeRow = parked ? null : activeID;
  // Phase 9.7f: the roster context menu. Opened by right-click (desktop) or
  // long-press (touch), anchored at the pointer. Closing on any outside
  // click/escape keeps it from stranding. 50-5: carries the userID too --
  // the color half works by handle, the notification rule by id -- and the
  // channels got the same menu for their own rules.
  const [nickMenu, setNickMenu] = useState<
    { userID: string; handle: string; x: number; y: number } | null
  >(null);
  const [channelMenu, setChannelMenu] = useState<
    { channelID: string; name: string; x: number; y: number } | null
  >(null);
  // 54-4: the group overrides in play this render, and the menu's group-row
  // draft (seeded on open, committed explicitly).
  const overrides = groupOverrides ?? {};
  const [groupDraft, setGroupDraft] = useState("");
  // A long-press must NOT also fire the row's click (which opens the DM).
  // The pointer sequence is down -> (timer fires) -> up -> click, so we set
  // a flag when the timer fires and consume it in the click handler.
  const longPressFired = useRef(false);
  const longPressTimer = useRef<number | null>(null);

  const colorMenuEnabled = nickColorsEnabled !== false && !!onSetFriendHue;

  // 50-5: quick-set rules live in the same store the rules panel edits;
  // a mute made here is viewable, editable, and deletable there.
  const [rulesConfig, updateRules] = useRulesConfig();

  // Keep the menu on-screen for presses near the right/bottom edge.
  const clampMenu = (x: number, y: number) => ({
    x: Math.min(x, Math.max(0, window.innerWidth - 210)),
    y: Math.min(y, Math.max(0, window.innerHeight - 150)),
  });

  const openNickMenu = (friend: Friend, x: number, y: number) => {
    const at = clampMenu(x, y);
    setChannelMenu(null);
    setNickMenu({ userID: friend.userID, handle: friend.handle, ...at });
  };

  const openChannelMenu = (ch: ChannelSummary, x: number, y: number) => {
    const at = clampMenu(x, y);
    setNickMenu(null);
    // 54-4: the group row edits a draft seeded with what the menu opened on
    // (the user's effective group), committed on Enter/blur/datalist pick.
    setGroupDraft(effectiveGroup(ch, overrides));
    setChannelMenu({ channelID: ch.id, name: ch.name, ...at });
  };

  const cancelLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  useEffect(() => {
    if (!nickMenu && !channelMenu) return;
    const close = () => {
      setNickMenu(null);
      setChannelMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // Capture phase: the menu stops propagation on its own clicks, so a
    // click anywhere else closes it.
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [nickMenu, channelMenu]);

  const sortedFriends = sortFriends(friends);

  const visibleFriends = filterRoster(
    sortedFriends,
    filter,
    (f) => f.handle || f.userID
  );
  const showFilter = showRosterFilter(sortedFriends.length);

  const visibleChannels = filterRoster(groupChannels, channelFilter, (ch) => ch.name);
  const showChannelFilter = showRosterFilter(groupChannels.length);

  // 54-3: grouped view. An active filter always renders flat -- a match
  // hidden inside a collapsed group would read as "filter is broken" -- and
  // a single group draws no headers. Collapse state is per-machine.
  const channelGroups = groupRoster(groupChannels, overrides);
  const groupedView =
    groupingEnabled && channelFilter.trim() === "" && channelGroups.length > 1;
  // 54-4: datalist + canonicalization target for the menu's group row.
  const groupNames = knownGroups(channels, overrides);

  // Commit the menu's group draft: canonicalize against the groups the user
  // already sees; landing back on the creator's suggestion CLEARS the
  // override rather than storing a redundant copy of it.
  const commitGroupDraft = () => {
    if (!channelMenu || !onSetChannelGroup) return;
    const ch = channels.find((c) => c.id === channelMenu.channelID);
    if (!ch) return;
    const next = canonicalizeGroup(groupDraft, groupNames);
    const suggested = ch.groupName.trim() || DEFAULT_GROUP;
    const current = effectiveGroup(ch, overrides);
    if (next.toLowerCase() === suggested.toLowerCase()) {
      if (overrides[ch.id] !== undefined) onSetChannelGroup(ch.id, null);
    } else if (next !== current) {
      onSetChannelGroup(ch.id, next);
    }
    setGroupDraft(next);
  };
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() =>
    loadCollapsedGroups()
  );
  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveCollapsedGroups(next);
      return next;
    });
  };

  // The channels <ul> renders one flat row list either way: headers
  // interleaved with the visible channels when grouped, just the filtered
  // channels when not. Keeps the (large) channel-row JSX single-sourced.
  type RosterRow =
    | { kind: "header"; group: RosterGroup }
    | { kind: "channel"; ch: ChannelSummary };
  const rosterRows: RosterRow[] = groupedView
    ? channelGroups.flatMap((g): RosterRow[] => [
        { kind: "header", group: g },
        ...(collapsedGroups.has(g.key)
          ? []
          : g.channels.map((ch): RosterRow => ({ kind: "channel", ch }))),
      ])
    : visibleChannels.map((ch): RosterRow => ({ kind: "channel", ch }));

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
          {onAddFriendClick && (
            <button
              class="chalk-sidebar-new"
              type="button"
              data-testid="sidebar-add-friend"
              onClick={onAddFriendClick}
              aria-label="add friend"
              title="add friend"
            >+</button>
          )}
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
            const isActive = dm !== null && dm.id === activeRow;
            const presenceState = presence[friend.userID];
            const dotClass = presenceClass(presenceState);
            const dotLabel = presenceLabel(presenceState);
            const displayName = friend.handle || friend.userID.slice(-8);
            // 47-5: same color the roster menu previews and chat renders.
            // Handle-less friends (userID slice as the label) stay untinted,
            // matching the message feed's rule for unresolvable senders.
            const nickHue = friend.handle
              ? (hueForHandle?.(friend.handle) ?? null)
              : null;
            // A DM has no mention concept (every message is addressed to
            // you), so the dot is always the plain variant.
            const dmUnread = dm !== null && hasUnread(unread[dm.id]);
            return (
              <li
                key={friend.userID}
                class={`chalk-sidebar-item chalk-sidebar-item--friend ${isActive ? "chalk-sidebar-item--active" : ""}`}
                data-testid="sidebar-friend-item"
                data-friend-id={friend.userID}
                data-active={isActive ? "true" : "false"}
                data-presence={presenceState ?? "offline"}
                onClick={(e) => {
                  // Swallow the click that follows a long-press, otherwise
                  // opening the color menu would also open the DM. 48-6: it
                  // must also stop bubbling -- the menu's window-level
                  // dismissal listener sits above us, and letting the click
                  // through closed the menu the press had just opened.
                  if (longPressFired.current) {
                    longPressFired.current = false;
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                  }
                  onFriendClick(friend.userID);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openNickMenu(friend, e.clientX, e.clientY);
                }}
                onPointerDown={(e) => {
                  if (e.pointerType === "mouse") return; // right-click covers desktop
                  cancelLongPress();
                  const x = e.clientX;
                  const y = e.clientY;
                  longPressTimer.current = window.setTimeout(() => {
                    longPressFired.current = true;
                    openNickMenu(friend, x, y);
                  }, 500);
                }}
                onPointerUp={cancelLongPress}
                onPointerLeave={cancelLongPress}
                onPointerCancel={cancelLongPress}
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
                <span
                  class={`chalk-sidebar-item-name ${nickHue !== null ? "chalk-nick-tinted" : ""}`}
                  style={nickHue !== null ? nickTintStyle(nickHue) : undefined}
                >
                  {displayName}
                </span>
                {dmUnread && <UnreadDot mention={false} />}
              </li>
            );
          })}
        </ul>
      </div>

      {/* ---- parking lot (53-1) ---- */}
      {parkingName && onPark && (
        <div class="chalk-sidebar-section chalk-sidebar-section--parking">
          <button
            type="button"
            class={`chalk-sidebar-parking ${parked ? "chalk-sidebar-parking--active" : ""}`}
            data-testid="sidebar-parking"
            data-active={parked ? "true" : "false"}
            onClick={onPark}
            title={`${parkingName} — hide the conversation`}
            aria-label={`${parkingName} — hide the conversation`}
            aria-pressed={parked}
          >
            <span class="chalk-sidebar-parking-glyph">
              <ParkingIcon />
            </span>
            <span class="chalk-sidebar-item-name">{parkingName}</span>
          </button>
        </div>
      )}

      {/* ---- threads entry (49-6) ---- */}
      {onOpenThreads && (
        <div class="chalk-sidebar-section chalk-sidebar-section--threads">
          <button
            type="button"
            class="chalk-sidebar-threads"
            data-testid="sidebar-threads"
            onClick={onOpenThreads}
            title={
              threadsUnread > 0
                ? `${threadsUnread} thread${threadsUnread === 1 ? "" : "s"} need you`
                : "active threads"
            }
            aria-label={
              threadsUnread > 0 ? "active threads, some need you" : "active threads"
            }
          >
            <span class="chalk-sidebar-threads-glyph" aria-hidden="true">
              ↳
            </span>
            <span class="chalk-sidebar-title">threads</span>
            {threadsUnread > 0 && <UnreadDot mention={false} />}
          </button>
        </div>
      )}

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

        {showChannelFilter && (
          <div class="chalk-sidebar-filter">
            <input
              type="text"
              class="chalk-sidebar-filter-input"
              data-testid="sidebar-channels-filter"
              placeholder="filter…"
              value={channelFilter}
              onInput={(e) => setChannelFilter((e.target as HTMLInputElement).value)}
              aria-label="filter channels"
            />
          </div>
        )}

        <ul
          class="chalk-sidebar-list chalk-sidebar-list--channels"
          data-testid="sidebar-list"
        >
          {groupChannels.length === 0 && (
            <li class="chalk-sidebar-empty">no channels yet</li>
          )}
          {groupChannels.length > 0 && visibleChannels.length === 0 && (
            <li class="chalk-sidebar-empty">no matches</li>
          )}
          {rosterRows.map((row) => {
            if (row.kind === "header") {
              const g = row.group;
              const isCollapsed = collapsedGroups.has(g.key);
              // Rolled-up dot, only while folded: same countsAsUnread call
              // the rows themselves make, so folding a group can't become
              // an accidental mute. Mention variant wins.
              let rollUnread = false;
              let rollMention = false;
              if (isCollapsed) {
                for (const ch of g.channels) {
                  const u = unread[ch.id];
                  const r = ch.channelType === "voice" ? (voiceRosters[ch.id] ?? []) : [];
                  const inR = !!ownUserID && r.some((p) => p.userID === ownUserID);
                  if (countsAsUnread(u, ch.channelType, inR)) {
                    rollUnread = true;
                    if (u.mention) rollMention = true;
                  }
                }
              }
              return (
                <li key={"group:" + g.key} class="chalk-sidebar-group">
                  <button
                    type="button"
                    class="chalk-sidebar-group-header"
                    data-testid="sidebar-group-header"
                    data-group={g.key}
                    data-collapsed={isCollapsed ? "true" : "false"}
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleGroup(g.key)}
                    title={isCollapsed ? `expand ${g.name}` : `collapse ${g.name}`}
                  >
                    <span class="chalk-sidebar-group-arrow" aria-hidden="true">
                      {isCollapsed ? "▸" : "▾"}
                    </span>
                    <span class="chalk-sidebar-group-name">{g.name}</span>
                    <span class="chalk-sidebar-count">({g.channels.length})</span>
                    {rollUnread && <UnreadDot mention={rollMention} />}
                  </button>
                </li>
              );
            }
            const ch = row.ch;
            const isVoice = ch.channelType === "voice";
            const roster = isVoice ? (voiceRosters[ch.id] ?? []) : [];
            const u = unread[ch.id];
            // 45-3: my own presence in the room decides whether the scratchpad
            // may show a dot. Read off the roster rather than the call session:
            // the server owns who is in the room, and this is the same list the
            // occupant sublist below renders.
            const inRoom = !!ownUserID && roster.some((p) => p.userID === ownUserID);
            const showUnread = countsAsUnread(u, ch.channelType, inRoom);
            return (
              <li
                key={ch.id}
                class={`chalk-sidebar-item ${isVoice ? "chalk-sidebar-item--voicech" : ""} ${ch.id === activeRow ? "chalk-sidebar-item--active" : ""} ${showUnread ? "chalk-sidebar-item--unread" : ""}`}
                data-testid="sidebar-item"
                data-channel-id={ch.id}
                data-channel-type={isVoice ? "voice" : "text"}
                data-active={ch.id === activeRow ? "true" : "false"}
                onClick={(e) => {
                  // 50-5: same long-press/click interplay as the friend rows.
                  if (longPressFired.current) {
                    longPressFired.current = false;
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                  }
                  onSelect(ch.id);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openChannelMenu(ch, e.clientX, e.clientY);
                }}
                onPointerDown={(e) => {
                  if (e.pointerType === "mouse") return; // right-click covers desktop
                  cancelLongPress();
                  const x = e.clientX;
                  const y = e.clientY;
                  longPressTimer.current = window.setTimeout(() => {
                    longPressFired.current = true;
                    openChannelMenu(ch, x, y);
                  }, 500);
                }}
                onPointerUp={cancelLongPress}
                onPointerLeave={cancelLongPress}
                onPointerCancel={cancelLongPress}
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
                  {showUnread && <UnreadDot mention={u.mention} />}
                </span>
                {/* 30-5: live occupant sublist. Rendered inside the channel
                    <li> (still one click target); pointer events fall through
                    to the channel select. */}
                {isVoice && roster.length > 0 && (
                  <ul
                    class="chalk-sidebar-occupants"
                    data-testid="sidebar-voice-occupants"
                  >
                    {roster.map((p) => {
                      const isOwn = !!ownUserID && p.userID === ownUserID;
                      const handle = occupantHandle(ch, p.userID);
                      const hue = isOwn
                        ? (selfHue ?? null)
                        : handle
                          ? (hueForHandle?.(handle) ?? null)
                          : null;
                      return (
                        <li
                          class="chalk-sidebar-occupant"
                          key={p.userID + ":" + p.deviceID}
                          data-user-id={p.userID}
                        >
                          <span
                            class={`chalk-sidebar-occupant-name ${hue !== null ? "chalk-nick-tinted" : ""}`}
                            style={hue !== null ? nickTintStyle(hue) : undefined}
                          >
                            {occupantName(ch, ownUserID, p.userID)}
                          </span>
                          {p.muted && <MicOffIcon />}
                          {p.videoOn && <CamIcon />}
                          {p.screenOn && <ScreenIcon />}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>


      {/* Phase 9.7f / 50-5: per-friend context menu -- nick color plus the
          notification priority quick-set. Fixed-position so it escapes the
          sidebar's scroll container; stops click propagation so the global
          close-on-outside-click handler doesn't immediately dismiss it. */}
      {nickMenu && (
        <div
          class="chalk-nick-menu"
          style={`left:${nickMenu.x}px;top:${nickMenu.y}px`}
          onClick={(e) => e.stopPropagation()}
          data-testid="nick-color-menu"
          role="dialog"
          aria-label={`menu for ${nickMenu.handle || "friend"}`}
        >
          <div class="chalk-nick-menu-title">
            {colorMenuEnabled && nickMenu.handle && (
              <span
                class="chalk-nick-swatch"
                style={nickTintStyle(
                  hueForHandle?.(nickMenu.handle) ?? DEFAULT_SELF_HUE,
                  "background",
                )}
              />
            )}
            <span>{nickMenu.handle || nickMenu.userID.slice(-8)}</span>
          </div>
          {colorMenuEnabled && nickMenu.handle && (
            <div class="chalk-nick-menu-row">
              <input
                type="color"
                value={hexFromHue(hueForHandle?.(nickMenu.handle) ?? 210)}
                data-testid="nick-color-input"
                onChange={(e) => {
                  const hue = hueFromHex((e.target as HTMLInputElement).value);
                  if (hue !== null) onSetFriendHue?.(nickMenu.handle, hue);
                }}
              />
              <button
                type="button"
                class="chalk-nick-menu-btn"
                data-testid="nick-color-auto"
                onClick={() => {
                  onSetFriendHue?.(nickMenu.handle, null);
                  setNickMenu(null);
                }}
              >
                auto
              </button>
              <button
                type="button"
                class="chalk-nick-menu-btn"
                onClick={() => setNickMenu(null)}
              >
                done
              </button>
            </div>
          )}
          {/* 50-5: writes the same rule the panel's "per person" list
              edits; "default" clears it. */}
          <div class="chalk-nick-menu-row">
            <span class="chalk-nick-menu-label">notifications</span>
            <PrioritySelect
              value={rulesConfig.rules.users[nickMenu.userID] ?? null}
              withDefault
              testid="nick-menu-priority"
              onChange={(p) => updateRules(withUserRule(rulesConfig, nickMenu.userID, p))}
            />
          </div>
        </div>
      )}

      {/* 50-5: per-channel menu -- notification priority only, for now. A
          "mute" here is a rule like any other: it shows up in the rules
          panel and can be edited or deleted there. */}
      {channelMenu && (
        <div
          class="chalk-nick-menu"
          style={`left:${channelMenu.x}px;top:${channelMenu.y}px`}
          onClick={(e) => e.stopPropagation()}
          data-testid="channel-menu"
          role="dialog"
          aria-label={`menu for #${channelMenu.name}`}
        >
          <div class="chalk-nick-menu-title">
            <span>#{channelMenu.name}</span>
          </div>
          <div class="chalk-nick-menu-row">
            <span class="chalk-nick-menu-label">notifications</span>
            <PrioritySelect
              value={rulesConfig.rules.channels[channelMenu.channelID] ?? null}
              withDefault
              testid="channel-menu-priority"
              onChange={(p) => updateRules(withChannelRule(rulesConfig, channelMenu.channelID, p))}
            />
          </div>
          {/* 54-4: move to group. Free text + the groups already in the
              roster; committed on Enter/blur/pick (onChange covers the
              latter two). Typing the creator's suggestion back clears the
              override -- the reset button is the discoverable way to do
              the same. Only YOUR roster moves; everyone else keeps theirs. */}
          {onSetChannelGroup && (() => {
            const ch = channels.find((c) => c.id === channelMenu.channelID);
            if (!ch) return null;
            const overridden = overrides[ch.id] !== undefined;
            const suggested = ch.groupName.trim() || DEFAULT_GROUP;
            return (
              <div class="chalk-nick-menu-row">
                <span class="chalk-nick-menu-label">group</span>
                <input
                  type="text"
                  class="chalk-nick-menu-group-input"
                  data-testid="channel-menu-group"
                  value={groupDraft}
                  maxLength={80}
                  list="sidebar-group-options"
                  onInput={(e) => setGroupDraft((e.target as HTMLInputElement).value)}
                  onChange={commitGroupDraft}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitGroupDraft();
                      setChannelMenu(null);
                    }
                  }}
                  aria-label="move channel to group"
                />
                {overridden && (
                  <button
                    type="button"
                    class="chalk-nick-menu-btn"
                    data-testid="channel-menu-group-reset"
                    title={`back to the creator's suggestion (${suggested})`}
                    onClick={() => {
                      onSetChannelGroup(ch.id, null);
                      setGroupDraft(suggested);
                    }}
                  >
                    reset
                  </button>
                )}
                <datalist id="sidebar-group-options">
                  {groupNames.map((g) => (
                    <option key={g} value={g} />
                  ))}
                </datalist>
              </div>
            );
          })()}
        </div>
      )}

    </div>
  );
}

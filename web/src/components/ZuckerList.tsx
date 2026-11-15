// The phone's home screen (62-6, the only phone layout since 135-1): one list of every conversation, DMs and
// channels mixed, newest activity first, each row previewing the last
// message. Presentational only -- rows arrive pre-built from
// buildConversationList (chat/zucker.ts), navigation lives in App.
//
// The head buttons keep the entry points of the removed phone drawer: the
// parking lot, the thread inbox, add a friend, and new channel. The filter
// button is also in the head. Since 137-10 each is an icon button, and the
// parking lot and the threads are no longer pinned rows. The friends row
// (64-1) is a bar above the list. Since 137-11 it shows friend chips in up to
// two lines, and a count button at the right expands it in place to the full
// roster with presence, because the activity-sorted list buries anyone you
// have not talked to lately.
//
// 129-11: the seasonal scene can sit above the header as a row (`scene`).

import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { LONG_PRESS_MS, pressMoved } from "../chat/long-press"; // 135-8
import {
  rowLabel,
  splitVoice,
  type ZuckerFriend,
  type ZuckerOccupant,
  type ZuckerRow,
} from "../chat/zucker";
import type { PresenceMap } from "../state/types";
import {
  ZUCKER_KINDS,
  filterZuckerRows,
  zuckerFilterActive,
  type ZuckerKind,
} from "../chat/zucker-filter";
import { fmtRelative } from "../chat/reltime";
import { formatCountdown, countdownUrgent } from "../chat/countdown";
import { UnreadDot } from "./UnreadDot";
import { Flame } from "./Flame"; // 115-2
import { WaveName } from "./WaveName"; // 115-3
import { CamIcon, MicOffIcon, ScreenIcon } from "./Sidebar";
import {
  AddFriendIcon,
  ChannelGlyph,
  ChevronIcon,
  FilterIcon,
  NewChannelIcon,
  ParkingIcon,
  ReminderIcon,
  ThreadsIcon,
} from "./icons";
import { presenceClass, presenceLabel } from "../chat/presence";
import { FriendChips } from "./FriendChips";

interface Props {
  rows: ZuckerRow[];
  // 78-3: conversations this user has hidden from their roster. The sidebar
  // menu hides them, and the row sheet (135-8) hides them on the phone. Held
  // behind a "hidden" row under the list so the two views agree about what
  // the roster looks like.
  hiddenRows?: ZuckerRow[];
  presence: PresenceMap;
  friends: ZuckerFriend[];
  // 95-2/95-4: channel id -> who is in that room right now, for the pinned
  // voice row's "1/4 live" and each live room's occupant line. Absent means
  // nobody anywhere, which is what an empty voiceRosters map says too.
  voiceOccupants?: Record<string, ZuckerOccupant[]>;
  // null hides the row (prefs.parkingLot.hidden), mirroring the sidebar.
  parkingName: string | null;
  threadsUnread: number;
  // 87-4: remindersActive is the count of reminders that are not done. The head
  // button shows only when it is above 0, so the head stays short. remindersFired
  // is the count of fired reminders. Above 0, the button gets a dot.
  // onOpenReminders opens the Reminders panel.
  remindersActive: number;
  remindersFired: number;
  onOpenReminders: () => void;
  onSelect: (channelID: string) => void;
  onFriendSelect: (userID: string) => void;
  onPark: () => void;
  onOpenThreads: () => void;
  onAddFriend: () => void;
  onCreateChannel: () => void;
  // 80-14: the App's countdown tick, for ephemeral rooms' expiry badges.
  countdownNow?: number;
  // 115-2: the burst store's verdict and its window, as the sidebar gets them.
  hotChannels?: ReadonlySet<string>;
  burstMinutes?: number;
  // 115-3: friends whose name is waving right now (userID -> wave start).
  waves?: ReadonlyMap<string, number>;
  // 129-11: the seasonal scene row, or null. It renders as the first child,
  // above the header. The parent decides if it mounts. The list stays
  // presentational.
  scene?: ComponentChildren;
  /** 135-3: false while a chat covers the list. The default is true. The
   * list stays mounted, so its filter and its open sections survive. A
   * hidden element loses its scroll offset. The list saves the offset of
   * its rows on scroll and restores it when this prop becomes true. */
  shown?: boolean;
  /** 135-8: called with the channel id when a long press or a right-click
   * on a row asks for its sheet. */
  onRowMenu?: (channelID: string) => void;
}

export function ZuckerList({
  rows,
  hiddenRows = [],
  presence,
  friends,
  voiceOccupants = {},
  parkingName,
  threadsUnread,
  remindersActive,
  remindersFired,
  onOpenReminders,
  onSelect,
  onFriendSelect,
  onPark,
  onOpenThreads,
  onAddFriend,
  onCreateChannel,
  countdownNow,
  hotChannels,
  burstMinutes = 4,
  waves,
  scene,
  shown = true,
  onRowMenu,
}: Props) {
  // 135-8: one long press at a time. The fired flag stops the click that
  // ends a long press from also opening the conversation.
  const press = useRef<{ id: string; x: number; y: number; timer: number } | null>(null);
  const fired = useRef(false);
  const endPress = () => {
    if (press.current) window.clearTimeout(press.current.timer);
    press.current = null;
  };
  const pressHandlers = (id: string) =>
    onRowMenu
      ? {
          onPointerDown: (e: PointerEvent) => {
            if (e.button !== 0) return;
            endPress();
            fired.current = false;
            const timer = window.setTimeout(() => {
              press.current = null;
              fired.current = true;
              onRowMenu(id);
            }, LONG_PRESS_MS);
            press.current = { id, x: e.clientX, y: e.clientY, timer };
          },
          onPointerMove: (e: PointerEvent) => {
            const p = press.current;
            if (p && pressMoved(e.clientX - p.x, e.clientY - p.y)) endPress();
          },
          onPointerUp: endPress,
          onPointerCancel: endPress,
          onContextMenu: (e: MouseEvent) => {
            e.preventDefault();
            endPress();
            fired.current = true;
            onRowMenu(id);
          },
        }
      : {};
  const rowsRef = useRef<HTMLUListElement>(null);
  const rowsScroll = useRef(0);
  useLayoutEffect(() => {
    if (shown && rowsRef.current) rowsRef.current.scrollTop = rowsScroll.current;
  }, [shown]);
  const [friendsOpen, setFriendsOpen] = useState(false);
  // 64-2/64-5, 137-9: the filter bar is behind the filter button of the head
  // (a funnel icon since 137-10). It has a name field and a kind chip. The text matches as in the sidebar's
  // rosters (54-1), on the row's match text when it has one. Closing the bar
  // clears the text and the kind, so no invisible filter stays active.
  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [kind, setKind] = useState<ZuckerKind>("all");
  const filtering = zuckerFilterActive(kind, filter);
  const filterRef = useRef<HTMLInputElement>(null);
  // Layout effect: focus at commit, before paint, so opening the filter
  // never shows an unfocused field first. The owner decided in 137-9 that the
  // name field keeps this automatic focus.
  useLayoutEffect(() => {
    if (filterOpen) filterRef.current?.focus();
  }, [filterOpen]);
  // 95-2: voice rooms are a place, not a conversation -- they live behind
  // their own pinned row rather than in the activity-sorted list. Split before
  // the filter so the filter can then run over each half independently.
  const { rest: chatRows, rooms: voiceRows } = splitVoice(rows);
  const visibleRows = filterZuckerRows(chatRows, kind, filter);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const shownVoice = filterZuckerRows(voiceRows, kind, filter);
  // A collapsed row must not swallow a search hit: while filtering, the voice
  // list opens itself if it has matches (and stays shut when it has none, so
  // the row does not flash open on every keystroke). 137-9: the kind counts
  // as a filter, and the hidden shelf does the same below.
  const voiceShowing = filtering ? shownVoice.length > 0 : voiceOpen;
  const liveRooms = voiceRows.filter(
    (r) => (voiceOccupants[r.id] ?? []).length > 0,
  ).length;
  // Same reason the hidden shelf carries one: a room's scratchpad can go unread
  // behind a closed row, and hiding it is not muting it.
  const voiceUnread = voiceRows.some((r) => r.unread);
  const voiceMention = voiceRows.some((r) => r.unread && r.mention);
  const onlineCount = friends.filter((f) => f.presence === "online").length;
  // 78-3: the hidden shelf. Open state is component state, like the
  // sidebar's: a peek, not a setting.
  const [hiddenOpen, setHiddenOpen] = useState(false);
  const shownHidden = filterZuckerRows(hiddenRows, kind, filter);
  // 137-9: while filtering, the shelf opens on a hit and closes on none.
  const hiddenShowing = filtering ? shownHidden.length > 0 : hiddenOpen;
  const hiddenUnread = hiddenRows.some((r) => r.unread);
  const hiddenMention = hiddenRows.some((r) => r.unread && r.mention);
  // One clock per render, the MessageList precedent: a list of relative
  // times must agree with itself.
  const now = new Date();

  const conversationRow = (r: ZuckerRow, hidden: boolean) => {
    // 95-4: an empty room previews "voice room" forever (95-2's complaint
    // about it in the main list holds here too), but a room with people in it
    // has exactly one thing worth a line: who. That answers the question the
    // "1/4 live" count raises rather than repeating a scratchpad line nobody
    // opened the shelf for -- and it is why the shelf is sized to grow.
    const occupants = voiceOccupants[r.id] ?? [];
    return (
      <li key={r.id}>
        <button
          type="button"
          class={`chalk-zucker-row ${hidden ? "chalk-zucker-row--hidden" : ""} ${r.unread ? "chalk-zucker-row--unread" : ""}`}
          onClick={() => {
            if (fired.current) {
              fired.current = false;
              return;
            }
            onSelect(r.id);
          }}
          {...pressHandlers(r.id)}
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
              {/* 115-2: before the name, where a narrow screen cannot lose it. */}
              {hotChannels?.has(r.id) && <Flame channelID={r.id} minutes={burstMinutes} />}
              <span class="chalk-zucker-row-name">{rowLabel(r)}</span>
              {r.expiresAt != null && countdownNow != null && (
                <span
                  class={
                    "chalk-expiry-badge" +
                    (countdownUrgent(r.expiresAt - countdownNow) ? " chalk-expiry-badge--urgent" : "")
                  }
                  data-testid="zucker-expiry"
                >
                  {formatCountdown(r.expiresAt - countdownNow)}
                </span>
              )}
              <span class="chalk-zucker-row-when">
                {fmtRelative(new Date(r.when), now)}
              </span>
            </span>
            {/* 137-3: the dot is in this line, not a column of the row, so the
                time ends at the same edge on every row. */}
            <span class="chalk-zucker-row-bottom">
              {occupants.length > 0 ? (
                <span
                  class="chalk-zucker-row-occupants"
                  data-testid="zucker-voice-occupants"
                >
                  {occupants.map((o) => (
                    <span
                      class="chalk-zucker-occupant"
                      key={o.userID}
                      data-user-id={o.userID}
                    >
                      <span class="chalk-zucker-occupant-name">{o.name}</span>
                      {o.muted && <MicOffIcon />}
                      {o.videoOn && <CamIcon />}
                      {o.screenOn && <ScreenIcon />}
                    </span>
                  ))}
                </span>
              ) : (
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
              )}
              {r.unread && <UnreadDot mention={r.mention} />}
            </span>
          </span>
        </button>
      </li>
    );
  };

  return (
    <div class="chalk-zucker" data-testid="zucker-list">
      {scene}
      {/* 137-10: six icon buttons follow the title: parking lot, threads,
          reminders, filter, add a friend, and new channel. Each icon is
          decoration and the button carries the label. The parking lot button
          has the name of the parking lot, because a user can rename it. It
          does not show when parkingName is null. The reminders button (87-4)
          shows only when a reminder is active. */}
      <div class="chalk-zucker-head">
        <span class="chalk-zucker-title">conversations</span>
        {parkingName !== null && (
          <button
            type="button"
            class="chalk-zucker-add"
            onClick={onPark}
            title={parkingName}
            aria-label={parkingName}
            data-testid="zucker-parking"
          >
            <ParkingIcon size={18} />
          </button>
        )}
        <button
          type="button"
          class="chalk-zucker-add"
          onClick={onOpenThreads}
          title={threadsUnread > 0 ? "threads, unread replies" : "threads"}
          aria-label={threadsUnread > 0 ? "threads, unread replies" : "threads"}
          data-testid="zucker-threads"
        >
          <ThreadsIcon />
          {/* A dot on the button shows unread replies. */}
          {threadsUnread > 0 && <span class="chalk-zucker-add-dot" aria-hidden="true" />}
        </button>
        {/* 87-4: the dot shows that a reminder has fired, as the dot of the
            threads button shows unread replies. */}
        {remindersActive > 0 && (
          <button
            type="button"
            class="chalk-zucker-add"
            onClick={onOpenReminders}
            title={remindersFired > 0 ? "reminders, some are due" : "reminders"}
            aria-label={remindersFired > 0 ? "reminders, some are due" : "reminders"}
            data-testid="zucker-reminders"
          >
            <ReminderIcon size={18} />
            {remindersFired > 0 && <span class="chalk-zucker-add-dot" aria-hidden="true" />}
          </button>
        )}
        <button
          type="button"
          class={`chalk-zucker-add ${filterOpen ? "chalk-zucker-add--active" : ""}`}
          onClick={() => {
            if (filterOpen) {
              setFilter("");
              setKind("all");
            }
            setFilterOpen(!filterOpen);
          }}
          title="filter conversations"
          aria-label="filter conversations"
          aria-pressed={filterOpen}
          data-testid="zucker-filter-toggle"
        >
          <FilterIcon />
        </button>
        <button
          type="button"
          class="chalk-zucker-add"
          onClick={onAddFriend}
          title="add a friend"
          aria-label="add a friend"
          data-testid="zucker-add-friend"
        >
          <AddFriendIcon />
        </button>
        <button
          type="button"
          class="chalk-zucker-add"
          onClick={onCreateChannel}
          title="new channel"
          aria-label="new channel"
          data-testid="zucker-new-channel"
        >
          <NewChannelIcon />
        </button>
      </div>

      {/* 137-9: the bar is directly under the head and above the rows it
          narrows. The chips scroll sideways. */}
      {filterOpen && (
        <div class="chalk-zucker-filter">
          <input
            type="text"
            class="chalk-sidebar-filter-input"
            data-testid="zucker-filter"
            placeholder="name…"
            value={filter}
            ref={filterRef}
            onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
            aria-label="filter conversations by name"
          />
          <div class="chalk-zucker-kinds" role="group" aria-label="show">
            {ZUCKER_KINDS.map((k) => (
              <button
                key={k.kind}
                type="button"
                class={`chalk-zucker-chip chalk-zucker-kind ${kind === k.kind ? "chalk-zucker-kind--on" : ""}`}
                aria-pressed={kind === k.kind}
                onClick={() => setKind(k.kind)}
                data-testid={`zucker-kind-${k.kind}`}
              >
                <span class="chalk-zucker-chip-pill">{k.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* 137-9: while the bar is open, the rows that are not conversations
          do not render. Since 137-10 this is only the friends row, because
          the parking lot and the threads are head buttons. The bar then sits
          above the rows it narrows, and the list keeps its height when the
          keyboard is up. The voice row stays, because it can hold hits. */}
      {!filterOpen && (
        <>
        {/* 137-11: the friends bar. The chips fill the bar, and the count button
            sits at the right end. The "@ friends" label shows only when there
            are no chips: an open list, or no friends. */}
        <div class="chalk-zucker-friendsbar">
          {friendsOpen || friends.length === 0 ? (
            <span class="chalk-zucker-friendsbar-label">@ friends</span>
          ) : (
            <FriendChips
              friends={friends}
              onSelect={onFriendSelect}
              onMore={() => setFriendsOpen(true)}
            />
          )}
          <button
            type="button"
            class="chalk-zucker-friends-toggle"
            onClick={() => setFriendsOpen(!friendsOpen)}
            aria-expanded={friendsOpen}
            aria-label={`friends, ${onlineCount} of ${friends.length} online`}
            title={`${onlineCount} of ${friends.length} friends online`}
            data-testid="zucker-friends"
          >
            <span class="chalk-zucker-pinned-note">
              {onlineCount}/{friends.length}
            </span>
            <span class="chalk-zucker-chevron" aria-hidden="true"><ChevronIcon /></span>
          </button>
        </div>
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
                  <span class="chalk-zucker-friend-name">
                    <WaveName name={f.name} since={waves?.get(f.userID) ?? null} />
                  </span>
                  <span class="chalk-zucker-friend-state">{f.presence}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        </>
      )}
      {/* 95-2: the rooms, behind one row, directly under the friends they are
          the other half of -- "who is around" and "where they are talking". */}
      {voiceRows.length > 0 && (
        <>
          <button
            type="button"
            class="chalk-zucker-pinned"
            onClick={() => setVoiceOpen(!voiceOpen)}
            aria-expanded={voiceShowing}
            data-testid="zucker-voice"
            data-open={voiceShowing ? "true" : "false"}
          >
            <span>@ voice</span>
            <span class="chalk-zucker-pinned-note">
              {liveRooms}/{voiceRows.length} live
            </span>
            {voiceUnread && <UnreadDot mention={voiceMention} />}
            <span class="chalk-zucker-chevron" aria-hidden="true"><ChevronIcon /></span>
          </button>
          {voiceShowing && (
            <ul
              class="chalk-zucker-rows chalk-zucker-rows--shelf"
              data-testid="zucker-voice-rows"
            >
              {shownVoice.map((r) => conversationRow(r, false))}
            </ul>
          )}
        </>
      )}

      <ul
        class="chalk-zucker-rows"
        data-testid="zucker-rows"
        ref={rowsRef}
        onScroll={(e) => {
          rowsScroll.current = (e.currentTarget as HTMLUListElement).scrollTop;
        }}
      >
        {/* 95-2, 137-9: "no matches" means that no list has a hit. A hit in the
            voice list or in the hidden shelf is a hit, and its list is open. */}
        {filtering && visibleRows.length === 0 && shownVoice.length === 0 && shownHidden.length === 0 && (
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
            aria-expanded={hiddenShowing}
            data-testid="zucker-hidden-toggle"
            data-open={hiddenShowing ? "true" : "false"}
          >
            <span>hidden</span>
            <span class="chalk-zucker-pinned-note">{hiddenRows.length}</span>
            {/* Hiding is not muting: a hidden conversation that needs you
                still says so from behind the row. */}
            {hiddenUnread && <UnreadDot mention={hiddenMention} />}
            <span class="chalk-zucker-chevron" aria-hidden="true"><ChevronIcon /></span>
          </button>
          {hiddenShowing && (
            <ul
              class="chalk-zucker-rows chalk-zucker-rows--shelf"
              data-testid="zucker-hidden-rows"
            >
              {shownHidden.map((r) => conversationRow(r, true))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

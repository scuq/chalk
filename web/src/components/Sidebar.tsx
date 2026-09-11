// Sidebar: roster (friends) + group-channels list + new-channel button.
// Phase 9.6c: presence dots, @ prefix dropped from sidebar roster.
// Phase 30 (30-5): Discord-style channel rows. Text channels carry a "❯"
// prompt glyph (the terminal aesthetic's answer to "#"); voice channels
// carry "▶" plus a LIVE occupant sublist -- who is in the room right now,
// with mute / camera / screen badges, visible without entering the channel.
// Occupancy is reducer-owned (voiceRosters): seeded by a voice_roster
// request per voice channel after the channel list loads, kept current by
// joined/left/state pushes.
// 100-1: voice rooms render in their own "voice" section directly above the
// channels list; only text channels stay in the grouped/filtered roster.

import { Avatar } from "./Avatar"; // 112-4
import { Flame } from "./Flame"; // 115-2
import { WaveName } from "./WaveName"; // 115-3
import { pickAvatar } from "../avatars/pick"; // 112-4
import type { AttachmentController } from "../attachments/pipeline"; // 112-4
import { useState, useRef, useEffect } from "preact/hooks";
import { DEFAULT_SELF_HUE, nickTintStyle } from "../chat/nickcolor";
import { HueSlider } from "./HueSlider"; // 117-1
import { PrioritySelect } from "./PrioritySelect";
import { filterRoster, showRosterFilter } from "../chat/roster-filter";
import { PARKING_HOTKEY_LABEL } from "../parking-hotkey";
import { formatCountdown, countdownUrgent } from "../chat/countdown";
import {
  DEFAULT_GROUP,
  canonicalizeGroup,
  effectiveGroup,
  groupRoster,
  knownGroups,
  loadCollapsedGroups,
  saveCollapsedGroups,
  splitVoice,
} from "../chat/channel-groups";
import type { RosterGroup } from "../chat/channel-groups";
import {
  GROUP_SORT_LABEL,
  moveInList,
  orderChannels,
  orderGroups,
  placeInList,
  type ChannelSortMode,
  type MoveTo,
} from "../chat/roster-order"; // 114
import { splitHidden } from "../chat/channel-hide";
import type { HideMode, HiddenChannel } from "../chat/channel-hide";
import {
  MAX_SHORT_NAME_LEN,
  filterText,
  labelIsAbbreviated,
  rosterLabel,
  shortNameLength,
} from "../chat/channel-names";
import type { NameStyle } from "../chat/channel-names";
import { withChannelRule, withUserRule } from "../notify/rules";
import { useRulesConfig } from "../notify/rules-store";
import { countsAsUnread, hasUnread } from "../state/types";
import type {
  ChannelSummary,
  ChannelUnread,
  Friend,
  LastSeenMap,
  PresenceMap,
  VoiceParticipant,
} from "../state/types";
import { rosterCardInfo } from "../chat/hovercard";
import { presenceClass, presenceLabel } from "../chat/presence";
import { HOVER_CARD_DELAY_MS, PersonCard, useHoverCard } from "./HoverCard";
import type { DisplayNameMap } from "../auth/display-names";

// 33-2: the unread marker. Extracted to UnreadDot.tsx in 62-6 so the
// Zuckermode conversation list renders the identical dot.
import { UnreadDot } from "./UnreadDot";

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
  // 92-2: last-activity times for those same friends, for the hover card's
  // "last seen" line. Optional so other Sidebar callers are unaffected; an
  // absent map just means every card is state-only.
  lastSeen?: LastSeenMap;
  // 92-5: profile display names by user_id, for the hover card's second
  // line. Optional and best-effort -- absent, or missing an entry, just
  // means a card with no display-name line.
  displayNames?: DisplayNameMap;
  // 30-5: live voice-room occupancy by channel id (reducer-owned).
  voiceRosters: Record<string, VoiceParticipant[]>;
  // 33-2: unread + mention state by channel id (reducer-owned). Missing
  // entry means "nothing unread".
  unread: Record<string, ChannelUnread>;
  onSelect: (channelID: string) => void;
  onFriendClick: (friendUserID: string) => void;
  // 80-14: the App's countdown tick (unix-millis). Present only while an
  // ephemeral channel exists; the expiry badge renders from it.
  countdownNow?: number;
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
  // 78-2: channels this user has taken off the roster (resolved prefs), and
  // the setter behind the context menu's visibility row -- null shows the
  // channel again. Hidden channels are still live: they keep their unread
  // and still notify, they are just held behind the "hidden" row at the
  // bottom of the list. Optional, same as the group pair above.
  hiddenChannels?: Record<string, HiddenChannel>;
  onSetChannelHidden?: (channelID: string, mode: HideMode | null) => void;
  // 114: what order the roster renders in (resolved prefs). channelSort is
  // the account default for the channels inside a group, groupSort overrides
  // it for one group, channelOrder holds a group's hand-written list and
  // groupOrder the reader's group order. Empty everything is today's roster.
  //
  // The setters write prefs, so they answer: null when the write went out, a
  // hint to show when it would not fit the 8 KiB the server takes. Passing
  // null as the list (or the mode) resets that group to the default.
  channelSort?: ChannelSortMode;
  groupSort?: Record<string, ChannelSortMode>;
  channelOrder?: Record<string, string[]>;
  groupOrder?: string[];
  onSetGroupSort?: (groupKey: string, mode: ChannelSortMode | null) => string | null;
  onSetChannelOrder?: (groupKey: string, ids: string[] | null) => string | null;
  onSetGroupOrder?: (keys: string[] | null) => string | null;
  // 114-4: a drag that crosses into another group. One call, not a 54-4 move
  // followed by an order write: the roster prefs go over the wire whole, so
  // two writes in the same tick would race and the second would undo the
  // first. group is the name to file the channel under, null to go back to
  // the creator's suggestion; ids is the target group's new order.
  onMoveChannelToGroup?: (
    channelID: string,
    group: string | null,
    groupKey: string,
    ids: string[],
  ) => string | null;
  // 114-2: activity per channel (state.activity), for the activity sort.
  // Only ts is read; the rest of the entry belongs to the message preview.
  activity?: Record<string, { ts: number }>;
  // 115-2: channels currently burning (the burst store's verdict), and the
  // window it was measured over, for the flame's tooltip. Absent or empty
  // means flair is off or nothing is busy -- the rows render as before.
  hotChannels?: ReadonlySet<string>;
  burstMinutes?: number;
  // 115-3: friends whose name is waving right now (userID -> wave start).
  waves?: ReadonlyMap<string, number>;
  // 106-3: which of a channel's names the rows show (resolved prefs;
  // "short" falls back to the full name where none is set).
  nameStyle?: NameStyle;
  // 106-2: rename / short-name edit from the context menu. Only the owner
  // of a non-DM, dictator-mode channel sees the rows; the server enforces
  // the same rule. An undefined field is left alone; shortName "" clears.
  onUpdateChannel?: (
    channelID: string,
    patch: { name?: string; shortName?: string },
  ) => void;
  // 111-2/111-9: the channel's header image. The sidebar only picks the
  // file and names the action; App owns the upload (it holds the channel
  // crypto), the editor, and the update_channel that follows. Picking a
  // file resolves once the upload is done and the editor is open -- it
  // rejects with something worth showing when it is not.
  // 112-4: profile pictures. A roster row is about a person, not a channel,
  // and a picture is encrypted per channel -- so the row draws whichever
  // shared channel's copy is to hand (pickAvatar), preferring the one on
  // screen because its key and bytes are most likely already decrypted.
  avatars?: Record<string, Record<string, string>>;
  // 115-8: the hover card's pictures, which may be on when the rows' are
  // off (flair's frames want the card to show them). Defaults to `avatars`.
  cardAvatars?: Record<string, Record<string, string>>;
  attachmentController?: AttachmentController;
  onPickChannelBanner?: (channelID: string, file: File) => Promise<void>;
  onEditChannelBanner?: (channelID: string) => void;
  onClearChannelBanner?: (channelID: string) => void;
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

export function MicOffIcon() {
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

export function CamIcon() {
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

export function ScreenIcon() {
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
  lastSeen,
  displayNames,
  voiceRosters,
  unread,
  onSelect,
  onFriendClick,
  countdownNow,
  nickColorsEnabled,
  hueForHandle,
  selfHue,
  onSetFriendHue,
  onCreateClick,
  onAddFriendClick,
  groupingEnabled = true,
  groupOverrides,
  onSetChannelGroup,
  hiddenChannels,
  onSetChannelHidden,
  channelSort = "created",
  groupSort,
  channelOrder,
  groupOrder,
  onSetGroupSort,
  onSetChannelOrder,
  onSetGroupOrder,
  onMoveChannelToGroup,
  activity,
  hotChannels,
  burstMinutes = 4,
  waves,
  nameStyle = "full",
  onUpdateChannel,
  avatars, // 112-4
  cardAvatars = avatars, // 115-8
  attachmentController,
  onPickChannelBanner,
  onEditChannelBanner,
  onClearChannelBanner,
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

  // 78-2: hidden channels come off the roster before anything else looks at
  // it -- the count, the filter threshold, the groups. They are held in
  // hiddenList and reachable through the "hidden" row under the list. The
  // watermark reads live unread state, not the summary's seed (33-1), which
  // is only as fresh as the frame that delivered the channel.
  const lastSeqOf = (ch: ChannelSummary) => unread[ch.id]?.lastSeq ?? ch.lastSeq;
  const hiddenEntries = hiddenChannels ?? {};
  const { visible: groupChannels, hidden: hiddenList } = splitHidden(
    channels.filter((ch) => !ch.isDM),
    hiddenEntries,
    lastSeqOf,
  );
  // 100-1: voice rooms come out of the roster and into their own section
  // above "channels" -- flat, ungrouped, unfiltered. Hidden channels already
  // left the list, so the shelf keeps holding both kinds.
  const { voice: voiceChannels, text: textChannels } = splitVoice(groupChannels);
  const [showHidden, setShowHidden] = useState(false);
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
  // 114-3: the group header's own menu -- sort mode, where the group sits
  // among the others, and "reset order". The header had no menu before this;
  // it only answered a click by collapsing.
  const [groupMenu, setGroupMenu] = useState<
    { key: string; name: string; x: number; y: number } | null
  >(null);
  // What the prefs write said when it refused: the roster's order is the
  // first thing to put LISTS rather than exceptions in a blob the server
  // caps at 8 KiB, so a refusal has to be visible rather than silent.
  const [orderHint, setOrderHint] = useState<string | null>(null);
  // 54-4: the group overrides in play this render, and the menu's group-row
  // draft (seeded on open, committed explicitly).
  const overrides = groupOverrides ?? {};
  const [groupDraft, setGroupDraft] = useState("");
  // 106-2/106-3: the rename rows' drafts, seeded when the menu opens.
  const [nameDraft, setNameDraft] = useState("");
  const [shortDraft, setShortDraft] = useState("");
  // 111-2: the banner row's state. "uploading" while the blob is going up
  // (the menu stays open, so there is somewhere to show it), and an error
  // string when it did not land -- a picture that silently failed to
  // become a banner is the worst outcome here.
  const [bannerBusy, setBannerBusy] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const bannerInputRef = useRef<HTMLInputElement | null>(null);
  // 92-1: the roster hover card. Held by userID rather than by value so a
  // presence push that lands while the card is open is reflected on the next
  // render. 92-4: the state, the timer and the placement live in the hook the
  // feed's card shares.
  const {
    card: hoverCard,
    arm: armHoverCard,
    close: closeHoverCard,
  } = useHoverCard<string>();
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
    setGroupMenu(null);
    closeHoverCard();
    setNickMenu({ userID: friend.userID, handle: friend.handle, ...at });
  };

  const openChannelMenu = (ch: ChannelSummary, x: number, y: number) => {
    const at = clampMenu(x, y);
    setNickMenu(null);
    setGroupMenu(null);
    // 114-3: a fresh menu never opens still showing the last write's refusal.
    setOrderHint(null);
    // 54-4: the group row edits a draft seeded with what the menu opened on
    // (the user's effective group), committed on Enter/blur/datalist pick.
    setGroupDraft(effectiveGroup(ch, overrides));
    // 106-2/106-3: the rename rows, seeded the same way.
    setNameDraft(ch.name);
    setShortDraft(ch.shortName ?? "");
    // 111-2: a fresh menu never opens still showing the last upload's error.
    setBannerBusy(false);
    setBannerError(null);
    setChannelMenu({ channelID: ch.id, name: ch.name, ...at });
  };

  // 106-2: commit a rename row. Nothing is sent when the draft equals what
  // the channel already has (blur after a no-op edit stays silent), and a
  // blank name is not a rename -- the draft snaps back instead.
  const commitNameDraft = () => {
    if (!channelMenu || !onUpdateChannel) return;
    const ch = channels.find((c) => c.id === channelMenu.channelID);
    if (!ch) return;
    const next = nameDraft.trim();
    if (!next) {
      setNameDraft(ch.name);
      return;
    }
    if (next === ch.name) return;
    onUpdateChannel(ch.id, { name: next });
  };
  const commitShortDraft = () => {
    if (!channelMenu || !onUpdateChannel) return;
    const ch = channels.find((c) => c.id === channelMenu.channelID);
    if (!ch) return;
    const next = shortDraft.trim();
    if (shortNameLength(next) > MAX_SHORT_NAME_LEN) return; // the input caps this; belt and braces
    if (next === (ch.shortName ?? "")) return;
    onUpdateChannel(ch.id, { shortName: next });
  };

  const cancelLongPress = () => {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  useEffect(() => {
    if (!nickMenu && !channelMenu && !groupMenu) return;
    const close = () => {
      setNickMenu(null);
      setChannelMenu(null);
      setGroupMenu(null);
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
  }, [nickMenu, channelMenu, groupMenu]);

  const sortedFriends = sortFriends(friends);

  const visibleFriends = filterRoster(
    sortedFriends,
    filter,
    (f) => f.handle || f.userID
  );
  const showFilter = showRosterFilter(sortedFriends.length);

  // 106-3: the filter matches either name -- the one on screen and the
  // one it stands for.
  // 114-1: the flat list has no groups, so no group can override the sort --
  // the account default is the only order there is. It still applies, or the
  // activity setting would silently do nothing for anyone who turned
  // grouping off.
  const visibleChannels = orderChannels(
    filterRoster(textChannels, channelFilter, filterText),
    channelSort,
    undefined,
    activity,
  );
  const showChannelFilter = showRosterFilter(textChannels.length);

  // 54-3: grouped view. An active filter always renders flat -- a match
  // hidden inside a collapsed group would read as "filter is broken" -- and
  // a single group draws no headers. Collapse state is per-machine.
  // 114-1: the order the reader asked for goes on here, after grouping and
  // before the row flatten -- one site, over data the client already holds.
  // With empty prefs both calls are the identity and the roster is byte for
  // byte what it was.
  const groupSorts = groupSort ?? {};
  const groupLists = channelOrder ?? {};
  const sortFor = (key: string): ChannelSortMode => groupSorts[key] ?? channelSort;
  const channelGroups = orderGroups(
    groupRoster(textChannels, overrides).map((g) => ({
      ...g,
      channels: orderChannels(g.channels, sortFor(g.key), groupLists[g.key], activity),
    })),
    groupOrder,
  );
  const groupedView =
    groupingEnabled && channelFilter.trim() === "" && channelGroups.length > 1;
  // 114-1: with grouping on and only one group there are no headers, but
  // the list IS that group -- so it renders in that group's order rather
  // than the account default's. Filtering still renders flat.
  const soleGroup =
    groupingEnabled && channelFilter.trim() === "" && channelGroups.length === 1
      ? channelGroups[0]
      : null;

  // 114-3: the group a menu row can be reordered inside -- null when what is
  // on screen is not in group order (grouping off, or a filter running),
  // because then there is nothing for "up" to mean. A hidden channel is off
  // the roster and so in no group either.
  const orderableGroupFor = (ch: ChannelSummary): RosterGroup | null => {
    if (!onSetChannelOrder || !groupingEnabled || channelFilter.trim() !== "") {
      return null;
    }
    if (ch.isDM || ch.channelType === "voice") return null;
    const key = effectiveGroup(ch, overrides).toLowerCase();
    return channelGroups.find((g) => g.key === key) ?? null;
  };
  // Every order write seeds its list with what is on screen, which is what
  // makes "up" mean "up from where I can see it" whichever mode the group
  // was in before -- and what turns that group manual on the way. The
  // write answers with a hint when it would not fit; the menu shows it.
  const moveChannel = (ch: ChannelSummary, to: MoveTo) => {
    const g = orderableGroupFor(ch);
    if (!g || !onSetChannelOrder) return;
    setOrderHint(
      onSetChannelOrder(
        g.key,
        moveInList(
          g.channels.map((c) => c.id),
          ch.id,
          to,
        ),
      ),
    );
  };
  const moveGroup = (key: string, to: MoveTo) => {
    if (!onSetGroupOrder) return;
    setOrderHint(
      onSetGroupOrder(
        moveInList(
          channelGroups.map((g) => g.key),
          key,
          to,
        ),
      ),
    );
  };
  // ---- 114-4: drag to reorder ---------------------------------------------
  //
  // Hand-rolled on pointer events, the SidebarResizer precedent. Mouse only:
  // touch already has the long-press menu, and a touch drag would fight the
  // drawer's swipe for the same gesture. Nothing about the ORDER depends on
  // this -- it is a faster way to say what the menus above already say.
  //
  // The drop target is computed as a list of slots (one before each row, one
  // at the end of each group) read off the DOM, so a collapsed group is a
  // slot too and the end of a list is not a special case.
  const listRef = useRef<HTMLUListElement | null>(null);
  const dragStart = useRef<
    { kind: "channel" | "group"; id: string; x: number; y: number } | null
  >(null);
  // Consumed by the row's click / the header's collapse, so finishing a drag
  // on top of a row doesn't also open or fold it.
  const dragFired = useRef(false);
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const autoScroll = useRef<number | null>(null);
  const [drag, setDrag] = useState<{ kind: "channel" | "group"; id: string } | null>(
    null,
  );
  const [dropAt, setDropAt] = useState<
    { groupKey: string; before: string | null; line: number } | null
  >(null);

  // The roster is only orderable while it is actually rendering in group
  // order -- see orderableGroupFor.
  const rosterInGroupOrder = groupingEnabled && channelFilter.trim() === "";
  const canDragChannels = !!onSetChannelOrder && rosterInGroupOrder;
  const canDragGroups = !!onSetGroupOrder && groupedView;

  const endDrag = () => {
    dragStart.current = null;
    lastPointer.current = null;
    if (autoScroll.current !== null) {
      window.clearInterval(autoScroll.current);
      autoScroll.current = null;
    }
    setDrag(null);
    setDropAt(null);
  };

  // Where the insertion line goes for the pointer at (x, y). Slots come off
  // the DOM in render order: every visible channel row opens a slot before
  // itself, and every group closes with one at its last row's bottom.
  const dropFor = (
    kind: "channel" | "group",
    y: number,
  ): { groupKey: string; before: string | null; line: number } | null => {
    const root = listRef.current;
    if (!root) return null;
    const top = root.getBoundingClientRect().top - root.scrollTop;
    const slots: { groupKey: string; before: string | null; y: number }[] = [];
    // A single group draws no header (54-3), so the list itself names it.
    let key = root.getAttribute("data-roster-group");
    let bottom: number | null = null;
    const closeGroup = () => {
      if (key !== null && bottom !== null && kind === "channel") {
        slots.push({ groupKey: key, before: null, y: bottom });
      }
    };
    for (const el of root.querySelectorAll<HTMLElement>("[data-group],[data-channel-id]")) {
      const rect = el.getBoundingClientRect();
      const header = el.getAttribute("data-group");
      if (header !== null) {
        closeGroup();
        key = header;
        bottom = rect.bottom;
        if (kind === "group") slots.push({ groupKey: header, before: header, y: rect.top });
        continue;
      }
      if (key === null) continue;
      if (el.getAttribute("data-hidden") === "true") continue; // the shelf is not a place
      bottom = rect.bottom;
      if (kind === "channel") {
        const id = el.getAttribute("data-channel-id");
        if (id) slots.push({ groupKey: key, before: id, y: rect.top });
      }
    }
    if (kind === "group") {
      if (key !== null && bottom !== null) slots.push({ groupKey: key, before: null, y: bottom });
    } else {
      closeGroup();
    }
    let best: { groupKey: string; before: string | null; y: number } | null = null;
    for (const slot of slots) {
      if (!best || Math.abs(slot.y - y) < Math.abs(best.y - y)) best = slot;
    }
    return best ? { groupKey: best.groupKey, before: best.before, line: best.y - top } : null;
  };

  // Near an edge the list scrolls itself, so a drag can reach a group that is
  // off-screen without letting go.
  const AUTOSCROLL_EDGE = 28;
  const AUTOSCROLL_STEP = 10;
  const trackDrag = (kind: "channel" | "group", x: number, y: number) => {
    lastPointer.current = { x, y };
    setDropAt(dropFor(kind, y));
    const root = listRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    const dir = y < rect.top + AUTOSCROLL_EDGE ? -1 : y > rect.bottom - AUTOSCROLL_EDGE ? 1 : 0;
    if (dir === 0) {
      if (autoScroll.current !== null) {
        window.clearInterval(autoScroll.current);
        autoScroll.current = null;
      }
      return;
    }
    if (autoScroll.current !== null) return;
    autoScroll.current = window.setInterval(() => {
      const at = lastPointer.current;
      if (!at || !listRef.current) return;
      listRef.current.scrollTop += dir * AUTOSCROLL_STEP;
      setDropAt(dropFor(kind, at.y));
    }, 16);
  };

  // A drag only starts once the pointer has actually travelled, so a click
  // that wobbles two pixels still selects the channel.
  const DRAG_THRESHOLD = 4;
  const onDragPointerDown = (
    kind: "channel" | "group",
    id: string,
    e: PointerEvent,
  ) => {
    // A fresh press starts with nothing to consume, so a drag that ended
    // without a click behind it can never swallow the next one.
    dragFired.current = false;
    if (e.pointerType !== "mouse" || e.button !== 0) return;
    if (kind === "channel" ? !canDragChannels : !canDragGroups) return;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragStart.current = { kind, id, x: e.clientX, y: e.clientY };
  };
  const onDragPointerMove = (id: string, e: PointerEvent) => {
    const start = dragStart.current;
    if (!start || start.id !== id) return;
    if (!drag) {
      const moved =
        Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) >= DRAG_THRESHOLD;
      if (!moved) return;
      setDrag({ kind: start.kind, id: start.id });
    }
    trackDrag(start.kind, e.clientX, e.clientY);
  };
  const onDragPointerUp = (id: string, e: PointerEvent) => {
    const start = dragStart.current;
    (e.currentTarget as HTMLElement).releasePointerCapture?.(e.pointerId);
    if (!start || start.id !== id) return;
    const target = dropAt;
    const dragging = drag;
    endDrag();
    if (!dragging || !target) return;
    dragFired.current = true;
    if (dragging.kind === "group") {
      if (!onSetGroupOrder) return;
      setOrderHint(
        onSetGroupOrder(
          placeInList(
            channelGroups.map((g) => g.key),
            dragging.id,
            target.before,
          ),
        ),
      );
      return;
    }
    const ch = channels.find((c) => c.id === dragging.id);
    const to = channelGroups.find((g) => g.key === target.groupKey);
    if (!ch || !to || !onSetChannelOrder) return;
    const ids = placeInList(
      to.channels.map((c) => c.id),
      ch.id,
      target.before,
    );
    if (effectiveGroup(ch, overrides).toLowerCase() === to.key) {
      setOrderHint(onSetChannelOrder(to.key, ids));
      return;
    }
    // Across into another group: that is a 54-4 move plus a placement, and
    // it has to be ONE write -- the roster object goes over whole, so two
    // would race and the second would undo the first. Landing back on the
    // creator's suggestion clears the override rather than storing a copy of
    // it, exactly as the menu's group row does.
    if (!onMoveChannelToGroup) return;
    const suggested = ch.groupName.trim() || DEFAULT_GROUP;
    setOrderHint(
      onMoveChannelToGroup(
        ch.id,
        to.name.toLowerCase() === suggested.toLowerCase() ? null : to.name,
        to.key,
        ids,
      ),
    );
  };
  // Escape gives the drag back with nothing moved.
  useEffect(() => {
    if (!drag) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        dragFired.current = true;
        endDrag();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drag]);
  // An unmount mid-drag must not leave the auto-scroll timer running.
  useEffect(
    () => () => {
      if (autoScroll.current !== null) window.clearInterval(autoScroll.current);
    },
    [],
  );

  const openGroupMenu = (g: RosterGroup, x: number, y: number) => {
    const at = clampMenu(x, y);
    setNickMenu(null);
    setChannelMenu(null);
    setOrderHint(null);
    setGroupMenu({ key: g.key, name: g.name, ...at });
  };

  // 54-4: datalist + canonicalization target for the menu's group row.
  // 100-1: voice rooms are out of the grouped roster, so their (now inert)
  // group suggestions stop feeding the datalist.
  const groupNames = knownGroups(
    channels.filter((ch) => ch.channelType !== "voice"),
    overrides,
  );

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
  // 54-3/78-2: rolled-up unread over a set of channels that isn't currently
  // rendering its own rows -- a folded group, or the hidden shelf. Same
  // countsAsUnread call the rows themselves make, so putting channels out of
  // sight can never become an accidental mute. Mention variant wins.
  const rollUp = (list: ChannelSummary[]) => {
    let anyUnread = false;
    let mention = false;
    for (const ch of list) {
      const u = unread[ch.id];
      const roster = ch.channelType === "voice" ? (voiceRosters[ch.id] ?? []) : [];
      const inRoom = !!ownUserID && roster.some((p) => p.userID === ownUserID);
      if (countsAsUnread(u, ch.channelType, inRoom)) {
        anyUnread = true;
        if (u.mention) mention = true;
      }
    }
    return { anyUnread, mention };
  };

  type RosterRow =
    | { kind: "header"; group: RosterGroup }
    | { kind: "hidden-header" }
    | { kind: "channel"; ch: ChannelSummary; hidden?: boolean };
  const rosterRows: RosterRow[] = groupedView
    ? channelGroups.flatMap((g): RosterRow[] => [
        { kind: "header", group: g },
        ...(collapsedGroups.has(g.key)
          ? []
          : g.channels.map((ch): RosterRow => ({ kind: "channel", ch }))),
      ])
    : (soleGroup ? soleGroup.channels : visibleChannels).map(
        (ch): RosterRow => ({ kind: "channel", ch }),
      );
  // 78-2: the hidden shelf, always last and never grouped -- what is on it
  // is a flat "these are put away", not part of the roster's shape.
  // Revealing it is component state, not a pref: a peek that followed you to
  // another machine (or survived a reload) would quietly stop meaning
  // hidden.
  if (hiddenList.length > 0) {
    rosterRows.push({ kind: "hidden-header" });
    if (showHidden) {
      for (const ch of filterRoster(hiddenList, channelFilter, filterText)) {
        rosterRows.push({ kind: "channel", ch, hidden: true });
      }
    }
  }

  // 100-1: one channel row, shared by the voice section and the channels
  // list below it. The JSX is large (badges, occupants, long-press) and must
  // not fork between the two lists.
  // 106-1: grouped is true for rows under a group header, which indent a
  // step so the header reads as their parent rather than a sibling.
  const channelRow = (
    ch: ChannelSummary,
    hidden = false,
    grouped = false,
    orderable = false,
  ) => {
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
        class={`chalk-sidebar-item ${isVoice ? "chalk-sidebar-item--voicech" : ""} ${ch.id === activeRow ? "chalk-sidebar-item--active" : ""} ${showUnread ? "chalk-sidebar-item--unread" : ""} ${hidden ? "chalk-sidebar-item--hidden" : ""} ${grouped ? "chalk-sidebar-item--grouped" : ""}`}
        data-testid="sidebar-item"
        data-channel-id={ch.id}
        data-hidden={hidden ? "true" : "false"}
        data-channel-type={isVoice ? "voice" : "text"}
        data-active={ch.id === activeRow ? "true" : "false"}
        data-dragging={drag?.kind === "channel" && drag.id === ch.id ? "true" : "false"}
        onClick={(e) => {
          // 50-5: same long-press/click interplay as the friend rows.
          // 114-4: and the same for a drag that finished on its own row.
          if (longPressFired.current || dragFired.current) {
            longPressFired.current = false;
            dragFired.current = false;
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
          if (e.pointerType === "mouse") {
            // 114-4: right-click still opens the menu; only the left button
            // picks a row up.
            if (orderable) onDragPointerDown("channel", ch.id, e);
            return; // right-click covers the desktop menu
          }
          cancelLongPress();
          const x = e.clientX;
          const y = e.clientY;
          longPressTimer.current = window.setTimeout(() => {
            longPressFired.current = true;
            openChannelMenu(ch, x, y);
          }, 500);
        }}
        onPointerMove={(e) => {
          if (orderable) onDragPointerMove(ch.id, e);
        }}
        onPointerUp={(e) => {
          cancelLongPress();
          if (orderable) onDragPointerUp(ch.id, e);
        }}
        onPointerLeave={cancelLongPress}
        onPointerCancel={(e) => {
          cancelLongPress();
          if (orderable) onDragPointerUp(ch.id, e);
        }}
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
          {/* 115-2: the flame goes BEFORE the name. The name truncates to
              the sidebar's width, so anything after it is the first thing a
              narrow sidebar loses -- and a flame nobody sees is no flame. */}
          {hotChannels?.has(ch.id) && <Flame channelID={ch.id} minutes={burstMinutes} />}
          {/* 106-3: the short name where the pref asks for it and one is
              set; the full name rides as the tooltip so nothing is lost. */}
          <span
            class="chalk-sidebar-item-name"
            title={labelIsAbbreviated(ch, nameStyle) ? ch.name : undefined}
          >
            {rosterLabel(ch, nameStyle)}
          </span>
          {/* 80-14: the ephemeral room's remaining life. Urgency is
              a class, never an inline style (CSP style-src 'self'). */}
          {ch.expiresAt != null && countdownNow != null && (
            <span
              class={
                "chalk-expiry-badge" +
                (countdownUrgent(ch.expiresAt - countdownNow) ? " chalk-expiry-badge--urgent" : "")
              }
              data-testid="sidebar-expiry"
              title="this room and everything in it disappear when the timer runs out"
            >
              {formatCountdown(ch.expiresAt - countdownNow)}
            </span>
          )}
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
  };

  // 92-1: everything the open card draws, resolved once. Null when no card is
  // open, or when its friend left the roster while it was up. The relative
  // time is fixed at open: a card is not held long enough to age.
  const hoverFriend = hoverCard
    ? (friends.find((f) => f.userID === hoverCard.data) ?? null)
    : null;
  const hoverInfo = hoverFriend
    ? rosterCardInfo({
        userID: hoverFriend.userID,
        handle: hoverFriend.handle,
        hue: hoverFriend.handle
          ? (hueForHandle?.(hoverFriend.handle) ?? null)
          : null,
        presence: presence[hoverFriend.userID],
        displayName: displayNames?.[hoverFriend.userID],
        lastSeenMS: lastSeen?.[hoverFriend.userID],
        showHint:
          findDMWithFriend(channels, hoverFriend.userID, ownUserID) === null,
        now: new Date(),
      })
    : null;

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
            // 92-1: the row carries no `title`. The hover card says all of
            // what it said and more, and leaving both would fade the
            // browser's own tooltip in over the card half a second later.
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
                  closeHoverCard();
                  onFriendClick(friend.userID);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  openNickMenu(friend, e.clientX, e.clientY);
                }}
                onPointerDown={(e) => {
                  closeHoverCard();
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
                onPointerCancel={cancelLongPress}
                // 92-1: mouse only. On touch this row's long press is already
                // the nick menu, and the mobile roster is ZuckerList anyway.
                onPointerEnter={(e) => {
                  if (e.pointerType !== "mouse") return;
                  armHoverCard(
                    friend.userID,
                    e.currentTarget as HTMLElement,
                    HOVER_CARD_DELAY_MS,
                  );
                }}
                onPointerLeave={() => {
                  cancelLongPress();
                  closeHoverCard();
                }}
                // :focus-visible rather than plain focus -- clicking a row
                // focuses it too, and popping the card as the DM opens is
                // noise. Keyboard roster navigation still gets it.
                onFocus={(e) => {
                  const row = e.currentTarget as HTMLElement;
                  if (!row.matches(":focus-visible")) return;
                  armHoverCard(friend.userID, row, 0);
                }}
                onBlur={closeHoverCard}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onFriendClick(friend.userID);
                  }
                }}
              >
                {/* Always-rendered dot column for consistent alignment. */}
                <span
                  class={`chalk-presence-dot ${dotClass}`}
                  aria-label={dotLabel}
                />
                {/* 112-4: whichever shared channel's copy is to hand. Rows
                    here are taller than a feed line, so a fixed 16px box
                    costs no height either. */}
                {(() => {
                  const pick = avatars ? pickAvatar(avatars, friend.userID, activeID) : null;
                  if (!pick) return null;
                  return (
                    <Avatar
                      channelID={pick.channelID}
                      attachmentID={pick.attachmentID}
                      controller={attachmentController ?? null}
                      alt=""
                      size="row"
                      userID={friend.userID} // 115-6
                      live={presenceState === "online"} // 115-7
                    />
                  );
                })()}
                {/* 115-2: a DM is a channel too; its flame sits on the friend,
                    before the name for the channel row's reason. */}
                {dm !== null && hotChannels?.has(dm.id) && (
                  <Flame channelID={dm.id} minutes={burstMinutes} />
                )}
                <span
                  class={`chalk-sidebar-item-name ${nickHue !== null ? "chalk-nick-tinted" : ""}`}
                  style={nickHue !== null ? nickTintStyle(nickHue) : undefined}
                >
                  {/* 115-3: plain text until this friend's wave runs. */}
                  <WaveName name={displayName} since={waves?.get(friend.userID) ?? null} />
                </span>
                {dmUnread && <UnreadDot mention={false} />}
              </li>
            );
          })}
        </ul>
      </div>

      {/* ---- parking lot (53-1) ----
           53-4: the row itself still only parks -- a double-click on it must
           not undo itself -- but the key it names does both ways now. */}
      {parkingName && onPark && (
        <div class="chalk-sidebar-section chalk-sidebar-section--parking">
          <button
            type="button"
            class={`chalk-sidebar-parking ${parked ? "chalk-sidebar-parking--active" : ""}`}
            data-testid="sidebar-parking"
            data-active={parked ? "true" : "false"}
            onClick={onPark}
            title={`${parkingName} — hide the conversation (${PARKING_HOTKEY_LABEL}, again to come back)`}
            aria-label={`${parkingName} — hide the conversation (${PARKING_HOTKEY_LABEL}, again to come back)`}
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

      {/* ---- voice section (100-1) ----
           Voice rooms sit in their own section directly above the channel
           list: a room you join is a different thing from a feed you read,
           and mixed into the grouped roster the two kinds blur. Flat on
           purpose -- there are rarely more than a handful -- and the channel
           filter below does not reach up here. The section only exists while
           there is a room to show; hidden voice rooms stay on the hidden
           shelf with everything else. */}
      {voiceChannels.length > 0 && (
        <div class="chalk-sidebar-section chalk-sidebar-section--voice">
          <div class="chalk-sidebar-header chalk-sidebar-header--voice">
            <span class="chalk-sidebar-title">
              voice <span class="chalk-sidebar-count">({voiceChannels.length})</span>
            </span>
          </div>
          <ul
            class="chalk-sidebar-list chalk-sidebar-list--voice"
            data-testid="sidebar-voice-list"
          >
            {voiceChannels.map((ch) => channelRow(ch))}
          </ul>
        </div>
      )}

      {/* ---- channels section ---- */}
      <div class="chalk-sidebar-section chalk-sidebar-section--channels">
        <div class="chalk-sidebar-header chalk-sidebar-header--channels">
          <span class="chalk-sidebar-title">
            channels {textChannels.length > 0 && (
              <span class="chalk-sidebar-count">({textChannels.length})</span>
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
          ref={listRef}
          class={`chalk-sidebar-list chalk-sidebar-list--channels${drag ? " chalk-sidebar-list--dragging" : ""}`}
          data-testid="sidebar-list"
          // 114-4: a lone group draws no header, so the list carries its key
          // -- otherwise a drag inside it would have no group to land in.
          data-roster-group={soleGroup?.key}
        >
          {/* The insertion line. Positioned in the list's own scrolled
              coordinates, so it stays where it was put while the edges
              auto-scroll under it. */}
          {drag && dropAt && (
            <li
              class="chalk-sidebar-dropline"
              style={`top:${dropAt.line}px`}
              data-testid="sidebar-dropline"
              aria-hidden="true"
            />
          )}
          {groupChannels.length === 0 && hiddenList.length === 0 && (
            <li class="chalk-sidebar-empty">no channels yet</li>
          )}
          {textChannels.length > 0 && visibleChannels.length === 0 && (
            <li class="chalk-sidebar-empty">no matches</li>
          )}
          {rosterRows.map((row) => {
            if (row.kind === "hidden-header") {
              // The shelf always carries its roll-up dot, folded or not:
              // hiding is not muting, and a hidden channel that needs you
              // has to be able to say so from behind the row.
              const roll = rollUp(hiddenList);
              return (
                <li key="hidden-shelf" class="chalk-sidebar-group">
                  <button
                    type="button"
                    class="chalk-sidebar-group-header"
                    data-testid="sidebar-hidden-toggle"
                    data-open={showHidden ? "true" : "false"}
                    aria-expanded={showHidden}
                    onClick={() => setShowHidden((v) => !v)}
                    title={
                      showHidden
                        ? "stop showing hidden channels"
                        : "show hidden channels"
                    }
                  >
                    <span class="chalk-sidebar-group-arrow" aria-hidden="true">
                      {showHidden ? "▾" : "▸"}
                    </span>
                    <span class="chalk-sidebar-group-name">hidden</span>
                    <span class="chalk-sidebar-count">({hiddenList.length})</span>
                    {roll.anyUnread && <UnreadDot mention={roll.mention} />}
                  </button>
                </li>
              );
            }
            if (row.kind === "header") {
              const g = row.group;
              const isCollapsed = collapsedGroups.has(g.key);
              // Rolled-up dot, only while folded -- expanded, the rows carry
              // their own.
              const roll = isCollapsed
                ? rollUp(g.channels)
                : { anyUnread: false, mention: false };
              return (
                <li
                  key={"group:" + g.key}
                  class="chalk-sidebar-group"
                  data-dragging={
                    drag?.kind === "group" && drag.id === g.key ? "true" : "false"
                  }
                >
                  <button
                    type="button"
                    class="chalk-sidebar-group-header"
                    data-testid="sidebar-group-header"
                    data-group={g.key}
                    data-collapsed={isCollapsed ? "true" : "false"}
                    aria-expanded={!isCollapsed}
                    onClick={() => {
                      // 114-3: a long-press opened the menu; it must not
                      // also fold the group on the way back up. Same
                      // consume-the-flag dance the channel rows do.
                      // 114-4: a drag that ended here does not fold it
                      // either.
                      if (longPressFired.current || dragFired.current) {
                        longPressFired.current = false;
                        dragFired.current = false;
                        return;
                      }
                      toggleGroup(g.key);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      openGroupMenu(g, e.clientX, e.clientY);
                    }}
                    onPointerDown={(e) => {
                      if (e.pointerType === "mouse") {
                        onDragPointerDown("group", g.key, e); // 114-4
                        return; // right-click covers desktop
                      }
                      cancelLongPress();
                      const x = e.clientX;
                      const y = e.clientY;
                      longPressTimer.current = window.setTimeout(() => {
                        longPressFired.current = true;
                        openGroupMenu(g, x, y);
                      }, 500);
                    }}
                    onPointerMove={(e) => onDragPointerMove(g.key, e)}
                    onPointerUp={(e) => {
                      cancelLongPress();
                      onDragPointerUp(g.key, e);
                    }}
                    onPointerLeave={cancelLongPress}
                    onPointerCancel={(e) => {
                      cancelLongPress();
                      onDragPointerUp(g.key, e);
                    }}
                    title={isCollapsed ? `expand ${g.name}` : `collapse ${g.name}`}
                  >
                    <span class="chalk-sidebar-group-arrow" aria-hidden="true">
                      {isCollapsed ? "▸" : "▾"}
                    </span>
                    <span class="chalk-sidebar-group-name">{g.name}</span>
                    <span class="chalk-sidebar-count">({g.channels.length})</span>
                    {roll.anyUnread && <UnreadDot mention={roll.mention} />}
                  </button>
                </li>
              );
            }
            // 106-1: rows under a group header (and on the opened hidden
            // shelf) indent beneath it; the flat, ungrouped list does not.
            return channelRow(
              row.ch,
              row.hidden,
              groupedView || row.hidden === true,
              // 114-4: the hidden shelf is a place things are put away, not
              // a place in the order.
              rosterInGroupOrder && row.hidden !== true,
            );
          })}
        </ul>
      </div>


      {/* 92-1: the roster hover card. Fixed-position for the same reason the
          menus are, and pointer-transparent -- it is a tooltip, and must never
          be the thing under the cursor when the row is clicked. */}
      {hoverCard && hoverInfo && (
        <PersonCard
          x={hoverCard.x}
          y={hoverCard.y}
          info={hoverInfo}
          testID="friend-hover-card"
          avatar={(() => {
            // 112-4: a card is about a person, so any shared channel's copy
            // of their picture will do.
            const pick = cardAvatars ? pickAvatar(cardAvatars, hoverCard.data, activeID) : null;
            if (!pick) return null;
            return (
              <Avatar
                channelID={pick.channelID}
                attachmentID={pick.attachmentID}
                controller={attachmentController ?? null}
                alt=""
                size="card"
                userID={hoverCard.data} // 115-6
                live={presence[hoverCard.data] === "online"} // 115-7
              />
            );
          })()}
        />
      )}

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
            <span>{nickMenu.handle || nickMenu.userID.slice(-8)}</span>
          </div>
          {/* 117-1: a hue strip with its live swatch on one row, the
              buttons under it. Only the hue is kept, so only the hue is
              offered; the swatch that used to sit in the title moved down
              beside the strip so it follows the drag. */}
          {colorMenuEnabled && nickMenu.handle && (
            <div class="chalk-nick-menu-row">
              <HueSlider
                hue={hueForHandle?.(nickMenu.handle) ?? DEFAULT_SELF_HUE}
                testid="nick-color-input"
                ariaLabel={`hue for ${nickMenu.handle}`}
                onChange={(hue) => onSetFriendHue?.(nickMenu.handle, hue)}
              />
            </div>
          )}
          {colorMenuEnabled && nickMenu.handle && (
            <div class="chalk-nick-menu-row">
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
            // 100-1: voice rooms live in their own section; groups no longer
            // apply to them, so offering a move here would be a lie.
            if (ch.channelType === "voice") return null;
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
          {/* 114-3: where this channel sits in its group. Using any of these
              says "I have an order", so the group switches to it -- picking
              a sort mode again from the group's header menu leaves the list
              in place for when you want it back. Reachable from the
              keyboard, and the only reorder gesture a phone has. */}
          {(() => {
            const ch = channels.find((c) => c.id === channelMenu.channelID);
            if (!ch) return null;
            const g = orderableGroupFor(ch);
            if (!g || !onSetChannelOrder || g.channels.length < 2) return null;
            const at = g.channels.findIndex((c) => c.id === ch.id);
            const first = at === 0;
            const last = at === g.channels.length - 1;
            // Words for the ends, arrows for the steps: ⤒ and ⤓ are exactly
            // the kind of glyph 30-5d took out of the roster, drawn
            // differently (or not at all) by each monospace font.
            const moves: { to: MoveTo; label: string; title: string; off: boolean }[] = [
              { to: "top", label: "top", title: `first in ${g.name}`, off: first },
              { to: "up", label: "↑", title: "up one", off: first },
              { to: "down", label: "↓", title: "down one", off: last },
              { to: "bottom", label: "end", title: `last in ${g.name}`, off: last },
            ];
            // The way back, for the roster that has no group header to
            // right-click: one group draws none (54-3), so without this
            // there would be no undo on a phone-sized roster.
            const ordered = groupLists[g.key] !== undefined;
            return (
              <div class="chalk-nick-menu-row">
                <span class="chalk-nick-menu-label">order</span>
                {moves.map((m) => (
                  <button
                    key={m.to}
                    type="button"
                    class="chalk-nick-menu-btn"
                    data-testid={"channel-menu-move-" + m.to}
                    disabled={m.off}
                    title={m.title}
                    aria-label={m.title}
                    onClick={() => moveChannel(ch, m.to)}
                  >
                    {m.label}
                  </button>
                ))}
                {ordered && (
                  <button
                    type="button"
                    class="chalk-nick-menu-btn"
                    data-testid="channel-menu-order-reset"
                    title={`forget your order for ${g.name}`}
                    onClick={() => setOrderHint(onSetChannelOrder(g.key, null))}
                  >
                    reset
                  </button>
                )}
              </div>
            );
          })()}
          {/* 106-2/106-3: rename, and the short name. Owner only, never a
              DM (its name is the other member's), and not in democratic
              mode (no rename proposal exists) -- the server refuses all
              three anyway; hiding the rows just keeps the menu honest.
              Unlike the group row above, these change what EVERY member
              sees, so they commit on Enter or blur only when the draft
              differs, and nothing is applied until the server answers. */}
          {onUpdateChannel && (() => {
            const ch = channels.find((c) => c.id === channelMenu.channelID);
            if (!ch || ch.isDM) return null;
            if (!ownUserID || ch.createdBy !== ownUserID) return null;
            if (ch.governanceMode === "democratic") return null;
            const shortLen = shortNameLength(shortDraft);
            return (
              <>
                <div class="chalk-nick-menu-row">
                  <span class="chalk-nick-menu-label">name</span>
                  <input
                    type="text"
                    class="chalk-nick-menu-group-input"
                    data-testid="channel-menu-name"
                    value={nameDraft}
                    maxLength={80}
                    onInput={(e) => setNameDraft((e.target as HTMLInputElement).value)}
                    onChange={commitNameDraft}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitNameDraft();
                        setChannelMenu(null);
                      }
                    }}
                    aria-label="rename channel"
                  />
                </div>
                <div class="chalk-nick-menu-row">
                  <span class="chalk-nick-menu-label">short</span>
                  <input
                    type="text"
                    class="chalk-nick-menu-group-input"
                    data-testid="channel-menu-short"
                    value={shortDraft}
                    onInput={(e) => {
                      // Cap by characters, not UTF-16 units: maxLength would
                      // let five emoji through and then the server refuses.
                      const v = (e.target as HTMLInputElement).value;
                      setShortDraft(
                        shortNameLength(v) > MAX_SHORT_NAME_LEN
                          ? Array.from(v.trim()).slice(0, MAX_SHORT_NAME_LEN).join("")
                          : v,
                      );
                    }}
                    onChange={commitShortDraft}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        commitShortDraft();
                        setChannelMenu(null);
                      }
                    }}
                    placeholder="none"
                    title={`up to ${MAX_SHORT_NAME_LEN} characters; blank clears it`}
                    aria-label="channel short name"
                  />
                  <span
                    class="chalk-nick-menu-hint"
                    data-testid="channel-menu-short-count"
                    aria-hidden="true"
                  >
                    {shortLen}/{MAX_SHORT_NAME_LEN}
                  </span>
                </div>
              </>
            );
          })()}
          {/* 111-2/111-9: the channel's header image, set where its other
              metadata is set. Same gate as the rename rows above -- owner,
              non-DM, dictator mode -- because a banner rewrites what every
              member sees at the top of the room. The menu only starts
              things: picking a file uploads it (encrypted under the channel
              key, never linked to a message) and hands it to the editor,
              which is where every choice about framing is made and the only
              thing that writes. */}
          {onPickChannelBanner && (() => {
            const ch = channels.find((c) => c.id === channelMenu.channelID);
            if (!ch || ch.isDM) return null;
            if (!ownUserID || ch.createdBy !== ownUserID) return null;
            if (ch.governanceMode === "democratic") return null;
            const has = !!ch.banner;
            const pick = (file: File) => {
              setBannerError(null);
              setBannerBusy(true);
              void onPickChannelBanner(ch.id, file)
                .then(() => {
                  setBannerBusy(false);
                  setChannelMenu(null);
                })
                .catch((err: unknown) => {
                  setBannerBusy(false);
                  setBannerError(err instanceof Error ? err.message : "upload failed");
                });
            };
            return (
              <div class="chalk-nick-menu-row">
                <span class="chalk-nick-menu-label">image</span>
                <input
                  ref={bannerInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  data-testid="channel-menu-banner-input"
                  onChange={(e) => {
                    const input = e.target as HTMLInputElement;
                    const file = input.files?.[0] ?? null;
                    // Clear the input so picking the same file twice still
                    // fires a change event.
                    input.value = "";
                    if (file) pick(file);
                  }}
                />
                <button
                  type="button"
                  class="chalk-nick-menu-btn"
                  data-testid="channel-menu-banner-set"
                  disabled={bannerBusy}
                  title={has ? "replace the header image" : "pin an image to the header"}
                  onClick={() => bannerInputRef.current?.click()}
                >
                  {bannerBusy ? "…" : has ? "replace" : "set"}
                </button>
                {has && !bannerBusy && onEditChannelBanner && (
                  <button
                    type="button"
                    class="chalk-nick-menu-btn"
                    data-testid="channel-menu-banner-edit"
                    title="how the picture sits in the band"
                    onClick={() => {
                      onEditChannelBanner(ch.id);
                      setChannelMenu(null);
                    }}
                  >
                    edit
                  </button>
                )}
                {has && !bannerBusy && onClearChannelBanner && (
                  <button
                    type="button"
                    class="chalk-nick-menu-btn"
                    data-testid="channel-menu-banner-clear"
                    title="remove the header image"
                    onClick={() => {
                      onClearChannelBanner(ch.id);
                      setChannelMenu(null);
                    }}
                  >
                    clear
                  </button>
                )}
                {bannerError && (
                  <span class="chalk-nick-menu-hint" data-testid="channel-menu-banner-error">
                    {bannerError}
                  </span>
                )}
              </div>
            );
          })()}
          {/* 78-2: take the channel off the roster. Two ways out of a list
              that has grown past what you read: "hide" until you ask for it
              back, and "till new" -- a watermark, so the channel returns by
              itself the next time someone posts. Neither is a mute: the
              notifications row above is where that lives. */}
          {onSetChannelHidden && (() => {
            const entry = hiddenEntries[channelMenu.channelID];
            const hiddenNow = entry !== undefined;
            return (
              <div class="chalk-nick-menu-row">
                <span class="chalk-nick-menu-label">roster</span>
                {hiddenNow ? (
                  <button
                    type="button"
                    class="chalk-nick-menu-btn"
                    data-testid="channel-menu-show"
                    title={
                      entry.mode === "always"
                        ? "hidden — put it back on the roster"
                        : "hidden until a new message — put it back now"
                    }
                    onClick={() => {
                      onSetChannelHidden(channelMenu.channelID, null);
                      setChannelMenu(null);
                    }}
                  >
                    show
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      class="chalk-nick-menu-btn"
                      data-testid="channel-menu-hide"
                      title="hide until you show it again"
                      onClick={() => {
                        onSetChannelHidden(channelMenu.channelID, "always");
                        setChannelMenu(null);
                      }}
                    >
                      hide
                    </button>
                    <button
                      type="button"
                      class="chalk-nick-menu-btn"
                      data-testid="channel-menu-hide-until"
                      title="hide until a new message arrives"
                      onClick={() => {
                        onSetChannelHidden(channelMenu.channelID, "untilNew");
                        setChannelMenu(null);
                      }}
                    >
                      till new
                    </button>
                  </>
                )}
              </div>
            );
          })()}
          {orderHint && (
            <div class="chalk-nick-menu-row">
              <span class="chalk-nick-menu-hint" data-testid="channel-menu-order-hint">
                {orderHint}
              </span>
            </div>
          )}
        </div>
      )}

      {/* 114-3: the group header's menu. Right-click on the desktop,
          long-press on the phone -- the header's plain click still means
          collapse, which is what it has always meant.

          Three things live here, and only here: what order this group's
          channels come in (its own, or the account default it inherits),
          where the group itself sits among the others, and the way back --
          "reset order" drops this group's hand-written list, its sort
          override and its place among the groups in one go. */}
      {groupMenu && (
        <div
          class="chalk-nick-menu"
          style={`left:${groupMenu.x}px;top:${groupMenu.y}px`}
          onClick={(e) => e.stopPropagation()}
          data-testid="group-menu"
          role="dialog"
          aria-label={`menu for the ${groupMenu.name} group`}
        >
          <div class="chalk-nick-menu-title">
            <span>{groupMenu.name}</span>
          </div>
          {onSetGroupSort && (
            <div class="chalk-nick-menu-row">
              <span class="chalk-nick-menu-label">sort by</span>
              <select
                class="chalk-nick-menu-select"
                data-testid="group-menu-sort"
                value={groupSorts[groupMenu.key] ?? channelSort}
                onChange={(e) => {
                  const mode = (e.target as HTMLSelectElement).value as ChannelSortMode;
                  // Landing back on the account default CLEARS the override
                  // rather than storing a copy of it, so changing the
                  // default later still moves this group with it.
                  setOrderHint(
                    onSetGroupSort(groupMenu.key, mode === channelSort ? null : mode),
                  );
                }}
                aria-label="sort this group's channels by"
              >
                {(["created", "activity", "manual"] as ChannelSortMode[]).map((m) => (
                  <option key={m} value={m}>
                    {GROUP_SORT_LABEL[m]}
                    {m === channelSort ? " (default)" : ""}
                  </option>
                ))}
              </select>
            </div>
          )}
          {onSetGroupOrder && channelGroups.length > 1 && (() => {
            const at = channelGroups.findIndex((g) => g.key === groupMenu.key);
            const first = at === 0;
            const last = at === channelGroups.length - 1;
            const moves: { to: MoveTo; label: string; title: string; off: boolean }[] = [
              { to: "top", label: "top", title: "first group", off: first },
              { to: "up", label: "↑", title: "up one", off: first },
              { to: "down", label: "↓", title: "down one", off: last },
              { to: "bottom", label: "end", title: "last group", off: last },
            ];
            return (
              <div class="chalk-nick-menu-row">
                <span class="chalk-nick-menu-label">move</span>
                {moves.map((m) => (
                  <button
                    key={m.to}
                    type="button"
                    class="chalk-nick-menu-btn"
                    data-testid={"group-menu-move-" + m.to}
                    disabled={m.off}
                    title={m.title}
                    aria-label={m.title}
                    onClick={() => moveGroup(groupMenu.key, m.to)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            );
          })()}
          {onSetChannelOrder && (
            <div class="chalk-nick-menu-row">
              <span class="chalk-nick-menu-label">order</span>
              <button
                type="button"
                class="chalk-nick-menu-btn"
                data-testid="group-menu-reset"
                title="forget this group's own order and where it sits"
                onClick={() => {
                  setOrderHint(onSetChannelOrder(groupMenu.key, null));
                  setGroupMenu(null);
                }}
              >
                reset
              </button>
            </div>
          )}
          {orderHint && (
            <div class="chalk-nick-menu-row">
              <span class="chalk-nick-menu-hint" data-testid="group-menu-order-hint">
                {orderHint}
              </span>
            </div>
          )}
        </div>
      )}

    </div>
  );
}

// chalk-web -- Zuckermode's unified conversation list, as pure data.
//
// One list of every conversation -- DMs and channels mixed -- sorted by most
// recent activity, each row carrying a one-line preview of the newest
// message. Pure and structurally typed on the search.ts/threadinbox.ts
// precedent so the whole thing is testable without a DOM or a reducer.

import { PLACEHOLDER_PLAINTEXT_BLOCKED } from "../crypto/channel-crypto";
import { parseGiphyBody } from "../giphy/giphy";
import { parseLinkPreviewBody } from "../linkpreview/linkpreview";
import { parseCodeBody } from "../code/code";
import { isUndecryptableBody } from "./search";
import { compareByActivity } from "./roster-order"; // 114-2
import {
  countsAsUnread,
  type ChannelActivity,
  type ChannelUnread,
} from "../state/types";

export const DELETED_PREVIEW = "[message deleted]";
// 74-4: what an uncaptioned snippet previews as, in the same bracketed shape
// the attachment and gif placeholders already use.
const CODE_PREVIEW = "[code]";

// Previews are one line of state, not a transcript: collapse whitespace and
// cap well past what any row can render, so a pasted wall of text doesn't
// sit in the store forever.
const PREVIEW_MAX = 200;

// previewText renders a decrypted body as the one-liner a conversation row
// shows. Sentinel bodies are parsed rather than shown raw (a giphy body is
// sentinel+URL, link-preview and code bodies embed payload JSON before the
// user's text); decrypt-failure placeholders pass through as-is -- they are
// the honest answer. An empty body after all that is an attachment-only send.
export function previewText(body: string): string {
  if (body === DELETED_PREVIEW) return DELETED_PREVIEW;
  if (body === PLACEHOLDER_PLAINTEXT_BLOCKED || isUndecryptableBody(body)) {
    return body;
  }
  const giphy = parseGiphyBody(body);
  if (giphy) return "[gif]";
  const code = parseCodeBody(body);
  if (code) {
    // The caption if there is one -- it is what the sender wrote. A bare
    // snippet gets a placeholder rather than its first line, which on a
    // one-line row would usually just be an import or a brace.
    return code.text.trim() !== "" ? squash(code.text) : CODE_PREVIEW;
  }
  const lp = parseLinkPreviewBody(body);
  if (lp) {
    const text = lp.text.trim() !== "" ? lp.text : lp.preview.title;
    return squash(text !== "" ? text : lp.preview.url);
  }
  const plain = squash(body);
  return plain === "" ? "[attachment]" : plain;
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, PREVIEW_MAX);
}

// The structural subset of ChannelSummary the list needs.
export interface ZuckerChannel {
  id: string;
  isDM: boolean;
  channelType: string;
  createdAt: Date;
  memberIDs?: string[];
  // 80-14: unix-millis when an ephemeral room self-destructs; undefined for
  // permanent channels.
  expiresAt?: number;
}

// One conversation row, ready to render.
export interface ZuckerRow {
  id: string;
  name: string;
  // 137-9: the text the filter searches. When it is absent, the filter
  // searches name. A channel row gives its full and short names.
  matchText?: string;
  isDM: boolean;
  isVoice: boolean;
  // Sort key and the row's relative-time stamp: newest activity, falling
  // back to channel creation for conversations that never said anything.
  when: number;
  // "you" for own sends, the sender's handle otherwise; null when there is
  // no activity or the sender is unknown (purged user).
  previewSender: string | null;
  preview: string | null;
  unread: boolean;
  mention: boolean;
  // The DM counterpart's user id, for the presence dot. Null for channels.
  otherUserID: string | null;
  // 80-14: expiry passthrough for the countdown badge.
  expiresAt?: number;
}

// 64-1: the pinned friends sublist -- every friend with their presence,
// online first, so finding someone doesn't mean scanning a conversation
// list that is sorted by activity, not by name.
export interface ZuckerFriend {
  userID: string;
  name: string;
  presence: "online" | "away" | "offline";
}

const PRESENCE_RANK = { online: 0, away: 1, offline: 2 } as const;

export function buildFriendList(
  friends: { userID: string; handle: string }[],
  presence: Record<string, string>,
): ZuckerFriend[] {
  const rows: ZuckerFriend[] = friends.map((f) => {
    const raw = presence[f.userID];
    return {
      userID: f.userID,
      name: f.handle || f.userID.slice(-8),
      presence: raw === "online" || raw === "away" ? raw : "offline",
    };
  });
  rows.sort(
    (a, b) =>
      PRESENCE_RANK[a.presence] - PRESENCE_RANK[b.presence] ||
      a.name.localeCompare(b.name),
  );
  return rows;
}

// 137-8: FRIEND_CHIPS_MAX is the most friend chips that FriendChips renders
// and measures. Friends past this count appear only in the "+N" chip.
export const FRIEND_CHIPS_MAX = 24;

// 137-8: chipsThatFit returns how many chips the line shows, in order.
// widths holds the width of each chip, available is the width of the line,
// gap is the space between two items, and moreWidth is the width of the "+N" chip.
// If every chip fits, it returns widths.length and keeps no room for "+N".
// Otherwise it returns the largest count that still leaves room for "+N".
// That count can be 0. If available is not a positive finite number, it returns 0.
export function chipsThatFit(
  widths: readonly number[],
  available: number,
  gap: number,
  moreWidth: number,
): number {
  if (!Number.isFinite(available) || available <= 0) return 0;
  let used = 0;
  let all = true;
  for (let i = 0; i < widths.length; i++) {
    used += widths[i] + (i > 0 ? gap : 0);
    if (used > available) {
      all = false;
      break;
    }
  }
  if (all) return widths.length;
  used = 0;
  let n = 0;
  for (let i = 0; i < widths.length; i++) {
    const next = used + widths[i] + (i > 0 ? gap : 0);
    if (next + gap + moreWidth > available) break;
    used = next;
    n = i + 1;
  }
  return n;
}

// buildConversationList flattens channels + activity + unread into the
// sorted row list. Name resolution is injected (nameFor wraps App's
// displayName; handleFor resolves a user id to a handle) so this module
// depends on data shapes, not on App.
export function buildConversationList(
  order: string[],
  channels: Record<string, ZuckerChannel>,
  activity: Record<string, ChannelActivity>,
  unread: Record<string, ChannelUnread>,
  ownUserID: string | null,
  voiceRoomID: string | null,
  nameFor: (ch: ZuckerChannel) => string,
  handleFor: (userID: string) => string,
  // 137-9: gives the filter text of a channel, or undefined to filter on the
  // shown name.
  matchTextFor?: (ch: ZuckerChannel) => string | undefined,
): ZuckerRow[] {
  const rows: ZuckerRow[] = [];
  for (const id of order) {
    const ch = channels[id];
    if (!ch) continue;
    const act = activity[id];
    const u = unread[id];
    const isVoice = ch.channelType === "voice";
    const showUnread = countsAsUnread(u, ch.channelType, voiceRoomID === ch.id);

    let previewSender: string | null = null;
    let preview: string | null = null;
    if (act) {
      preview = act.deleted ? DELETED_PREVIEW : act.preview;
      if (act.senderUserID !== null && preview !== null) {
        previewSender =
          ownUserID !== null && act.senderUserID === ownUserID
            ? "you"
            : handleFor(act.senderUserID);
      }
    }

    let otherUserID: string | null = null;
    if (ch.isDM && ownUserID !== null) {
      otherUserID = (ch.memberIDs ?? []).find((m) => m !== ownUserID) ?? null;
    }

    rows.push({
      id,
      name: nameFor(ch),
      matchText: matchTextFor?.(ch),
      isDM: ch.isDM,
      isVoice,
      when: act?.ts ?? ch.createdAt.getTime(),
      previewSender,
      preview,
      unread: showUnread,
      mention: showUnread && (u?.mention ?? false),
      otherUserID,
      expiresAt: ch.expiresAt,
    });
  }
  // Newest first; id tie-break keeps the order stable when timestamps
  // collide (bulk backfills, same-ms sends).
  // 114-2: the comparator moved to roster-order.ts when the desktop roster
  // grew an activity sort of its own. Shared rather than copied, so the two
  // views can never disagree about what "most recent" means.
  rows.sort(compareByActivity);
  return rows;
}

// 95-2: voice rooms out of the conversation list.
//
// The list is sorted by activity, and a voice room's activity is its
// scratchpad -- a handful of links dropped mid-call, which then outrank the
// conversations you actually read. Worse, a room is a place rather than a
// thread: its row previews "voice room" forever and answers a question nobody
// asked while scrolling for a person. So the rooms come out and sit behind one
// pinned row, exactly the way 64-1 took the friend roster out.
//
// Order is preserved in both halves (splitHidden's precedent), so the rooms
// stay activity-sorted among themselves.
export function splitVoice<T extends { isVoice: boolean }>(
  rows: T[],
): { rest: T[]; rooms: T[] } {
  const rest: T[] = [];
  const rooms: T[] = [];
  for (const r of rows) (r.isVoice ? rooms : rest).push(r);
  return { rest, rooms };
}

// 95-4: one person in a live room, as the phone's `@ voice` shelf draws them.
// Names are resolved before this reaches ZuckerList, which has no member
// lists to look them up in -- same injection buildConversationList uses.
export interface ZuckerOccupant {
  userID: string;
  name: string;
  muted: boolean;
  videoOn: boolean;
  screenOn: boolean;
}

// The structural subset of VoiceParticipant this needs.
interface RosterEntry {
  userID: string;
  deviceID: string;
  muted: boolean;
  videoOn: boolean;
  screenOn: boolean;
}

// buildVoiceOccupants reshapes the live rosters into per-room name lists.
//
// One row per *person*, not per device: the sidebar lists both of someone's
// devices because a desktop column can afford to, but on a phone two "carol"
// lines in a row read as a bug. Merging them means deciding what the badges
// say for a person who is in twice -- muted only when every one of their
// devices is (one open mic is an open mic), sending video or screen when any
// of them is. Own entry reads "you", the 30-5 rule, because seeing yourself
// listed is what tells you the join landed.
export function buildVoiceOccupants(
  rosters: Record<string, RosterEntry[]>,
  ownUserID: string | null,
  nameFor: (channelID: string, userID: string) => string,
): Record<string, ZuckerOccupant[]> {
  const out: Record<string, ZuckerOccupant[]> = {};
  for (const [channelID, roster] of Object.entries(rosters)) {
    const byUser = new Map<string, ZuckerOccupant>();
    for (const p of roster) {
      const prev = byUser.get(p.userID);
      if (prev) {
        prev.muted = prev.muted && p.muted;
        prev.videoOn = prev.videoOn || p.videoOn;
        prev.screenOn = prev.screenOn || p.screenOn;
        continue;
      }
      byUser.set(p.userID, {
        userID: p.userID,
        name:
          ownUserID !== null && p.userID === ownUserID
            ? "you"
            : nameFor(channelID, p.userID),
        muted: p.muted,
        videoOn: p.videoOn,
        screenOn: p.screenOn,
      });
    }
    out[channelID] = [...byUser.values()];
  }
  return out;
}

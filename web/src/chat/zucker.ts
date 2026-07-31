// chalk-web -- Zuckermode's unified conversation list, as pure data.
//
// One list of every conversation -- DMs and channels mixed -- sorted by most
// recent activity, each row carrying a one-line preview of the newest
// message. Pure and structurally typed on the search.ts/threadinbox.ts
// precedent so the whole thing is testable without a DOM or a reducer.

import { PLACEHOLDER_PLAINTEXT_BLOCKED } from "../crypto/channel-crypto";
import { parseGiphyBody } from "../giphy/giphy";
import { parseLinkPreviewBody } from "../linkpreview/linkpreview";
import { isUndecryptableBody } from "./search";
import {
  countsAsUnread,
  type ChannelActivity,
  type ChannelUnread,
} from "../state/types";

export const DELETED_PREVIEW = "[message deleted]";

// Previews are one line of state, not a transcript: collapse whitespace and
// cap well past what any row can render, so a pasted wall of text doesn't
// sit in the store forever.
const PREVIEW_MAX = 200;

// previewText renders a decrypted body as the one-liner a conversation row
// shows. Sentinel bodies are parsed rather than shown raw (a giphy body is
// sentinel+URL, a link-preview body embeds payload JSON before the user's
// text); decrypt-failure placeholders pass through as-is -- they are the
// honest answer. An empty body after all that is an attachment-only send.
export function previewText(body: string): string {
  if (body === DELETED_PREVIEW) return DELETED_PREVIEW;
  if (body === PLACEHOLDER_PLAINTEXT_BLOCKED || isUndecryptableBody(body)) {
    return body;
  }
  const giphy = parseGiphyBody(body);
  if (giphy) return "[gif]";
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
}

// One conversation row, ready to render.
export interface ZuckerRow {
  id: string;
  name: string;
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
      isDM: ch.isDM,
      isVoice,
      when: act?.ts ?? ch.createdAt.getTime(),
      previewSender,
      preview,
      unread: showUnread,
      mention: showUnread && (u?.mention ?? false),
      otherUserID,
    });
  }
  // Newest first; id tie-break keeps the order stable when timestamps
  // collide (bulk backfills, same-ms sends).
  rows.sort((a, b) => b.when - a.when || a.id.localeCompare(b.id));
  return rows;
}

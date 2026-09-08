// chalk-web -- userID -> display name, for the hover cards (92-5); and, from
// 115-6, userID -> avatar frame, for the pictures.
//
// The wire knows people by handle. Nothing that arrives over the websocket --
// not the friend list, not a channel's member list, not a message's
// sender_user_id -- carries the profile display name, so a card that wants to
// show one has to get it from somewhere else.
//
// That somewhere is GET /api/users/directory, which already returns
// {user_id, username, display_name} for every active account on the server
// and which the friends panel already fetches to render its "everyone here"
// list. Using it costs about one request per session and discloses nothing
// new: 59-1 made the directory deliberately open to any signed-in member, on
// the grounds that a self-hosted server where everyone arrived by invite is a
// place where members finding each other is the point.
//
// Rejected: widening the friend-list and member-list frames to carry the
// name. It is three layers (store, proto, ws handler) plus a migration's
// worth of care about which surfaces may see which name, to deliver a field
// that two tooltips read.
//
// 115-6 put the avatar frame on the same row and the same fetch, for the
// same reason. It is also why a changed frame reaches other people the way
// a changed display name does -- on their next fetch, which App triggers on
// every (re)connect -- and not over a push.
//
// WHY THE MAP KEEPS EMPTY NAMES. A user who never set a display name is
// stored as "" rather than left out, because the two mean different things
// here: absent is "we have never resolved this person" and triggers a
// refresh, "" is "we have, and there is nothing to show". Conflating them
// refetches the directory forever on behalf of everyone who skipped the
// field at signup. The frame map keeps "" for the same reason.

import { useEffect, useState } from "preact/hooks";
import { listUserDirectory } from "./users";

export type DisplayNameMap = Record<string, string>;
export type AvatarFrameMap = Record<string, string>;

// Module-level, so the components that want the maps and any remount share
// one directory rather than racing several.
let cache: DisplayNameMap | null = null;
let frames: AvatarFrameMap | null = null;
let inflight: Promise<DisplayNameMap> | null = null;
const listeners = new Set<() => void>();

function refresh(): Promise<DisplayNameMap> {
  if (inflight !== null) return inflight;
  inflight = listUserDirectory()
    .then((users) => {
      const map: DisplayNameMap = {};
      const fr: AvatarFrameMap = {};
      for (const u of users) {
        if (!u.user_id) continue;
        map[u.user_id] = u.display_name ?? "";
        fr[u.user_id] = u.avatar_frame ?? "";
      }
      cache = map;
      frames = fr;
      for (const fn of listeners) fn();
      return map;
    })
    .catch((err) => {
      // A tooltip line is not worth surfacing an error for; the cards render
      // without it. cache stays null so a later trigger retries.
      console.warn("display-name directory fetch failed:", err);
      return cache ?? {};
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

// refreshDirectory refetches on demand. 115-6: App calls it on every
// (re)connect, which is what makes a friend's changed frame or name show
// up without a reload -- the id-based trigger below only fires for people
// the map has never heard of.
export function refreshDirectory(): Promise<void> {
  return refresh().then(() => undefined);
}

// resetDisplayNames drops the session cache, so the next account does not
// inherit the previous one's directory.
export function resetDisplayNames(): void {
  cache = null;
  frames = null;
}

// useDisplayNames returns the map, empty until it arrives.
//
// `enabled` gates the fetch on being signed in -- the endpoint requires a
// session and would 401 through the whole login screen otherwise.
//
// `wanted` is the set of user ids whose cards this render could draw, and is
// what keeps the map from going stale: someone who registered, or was added
// to a channel, after the first fetch is an id the map has never heard of,
// and that is the one thing worth another request. Pass a memoised set --
// this runs whenever its identity changes -- and leave the viewer's own id
// out of it, since the directory deliberately omits the caller and an id
// that can never arrive would ask on every change.
export function useDisplayNames(
  enabled: boolean,
  wanted?: ReadonlySet<string>,
): DisplayNameMap {
  const [names, setNames] = useState<DisplayNameMap>(() => cache ?? {});

  useEffect(() => {
    const fn = () => setNames(cache ?? {});
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    if (cache === null) {
      void refresh();
      return;
    }
    for (const id of wanted ?? []) {
      if (!(id in cache)) {
        void refresh();
        return;
      }
    }
  }, [enabled, wanted]);

  return names;
}

// avatarFrameFor reads one person's frame off the cache: "" until the
// directory has arrived or when they have none. The hook below is this plus
// a subscription.
export function avatarFrameFor(userID: string | undefined): string {
  return userID && frames ? (frames[userID] ?? "") : "";
}

// useAvatarFrame returns one person's frame, "" until the directory has
// arrived or when they have none. It never fetches: the directory is
// fetched by useDisplayNames (App) and refreshDirectory (reconnect), and a
// picture has no business triggering a request. It does subscribe, so a
// picture on screen repaints when the directory lands.
export function useAvatarFrame(userID: string | undefined): string {
  const [frame, setFrame] = useState<string>(() => avatarFrameFor(userID));
  useEffect(() => {
    const fn = () => setFrame(avatarFrameFor(userID));
    fn();
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }, [userID]);
  return frame;
}

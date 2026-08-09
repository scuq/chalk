// chalk-web -- userID -> display name, for the hover cards (92-5).
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
// WHY THE MAP KEEPS EMPTY NAMES. A user who never set a display name is
// stored as "" rather than left out, because the two mean different things
// here: absent is "we have never resolved this person" and triggers a
// refresh, "" is "we have, and there is nothing to show". Conflating them
// refetches the directory forever on behalf of everyone who skipped the
// field at signup.

import { useEffect, useState } from "preact/hooks";
import { listUserDirectory } from "./users";

export type DisplayNameMap = Record<string, string>;

// Module-level, so the two components that want the map and any remount
// share one directory rather than racing several.
let cache: DisplayNameMap | null = null;
let inflight: Promise<DisplayNameMap> | null = null;
const listeners = new Set<(m: DisplayNameMap) => void>();

function refresh(): Promise<DisplayNameMap> {
  if (inflight !== null) return inflight;
  inflight = listUserDirectory()
    .then((users) => {
      const map: DisplayNameMap = {};
      for (const u of users) {
        if (u.user_id) map[u.user_id] = u.display_name ?? "";
      }
      cache = map;
      for (const fn of listeners) fn(map);
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

// resetDisplayNames drops the session cache, so the next account does not
// inherit the previous one's directory.
export function resetDisplayNames(): void {
  cache = null;
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
    listeners.add(setNames);
    return () => {
      listeners.delete(setNames);
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

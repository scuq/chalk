// chalk 112-4 -- finding a picture for a surface that has no channel.
//
// A profile picture is encrypted under a CHANNEL key, so it exists once per
// channel and is only readable with that channel's key. The feed and the
// members panel always know which channel they are in. The roster, the hover
// card and a friend row do not: they are about a person, not a room.
//
// So they ask this: given everything known about who has a picture where,
// which (channel, attachment) pair should this surface draw? Any channel
// shared with that person will do -- it is the same face. Each channel has its
// own attachment ID for it, and the picture cache is keyed by that ID. So the
// surface prefers a copy that is already decrypted in this tab, the copy of the
// preferred channel (the one on screen) first. If no copy is decrypted, it
// uses the preferred channel's copy when that has an entry, and any other
// copy if not.

export interface AvatarPick {
  channelID: string;
  attachmentID: string;
}

/**
 * pickAvatar finds a picture for one user. If `ready` is given, a copy for
 * which `ready(attachmentID)` is true wins: the copy of the `prefer` channel
 * first, then the first ready copy in any channel. If no copy is ready, or
 * `ready` is not given, `prefer` is tried first. Otherwise the channels are
 * searched in whatever order the map yields, which is stable for a given
 * state and irrelevant to the result: the picture is the same in every
 * channel, only its ciphertext differs.
 *
 * Returns null when this user has no picture anywhere the caller can see --
 * which is also what a user who has never set one looks like.
 */
export function pickAvatar(
  avatars: Record<string, Record<string, string>>,
  userID: string,
  prefer?: string | null,
  ready?: (attachmentID: string) => boolean,
): AvatarPick | null {
  if (!userID) return null;
  // 112-11: a decrypted copy wins over one that is not, the preferred
  // channel's copy first. Without this, a channel switch changes the
  // attachment to a copy that is not decrypted yet, and the row is blank
  // until the decrypt ends.
  if (ready) {
    const own = prefer ? avatars[prefer]?.[userID] : undefined;
    if (prefer && own && ready(own)) return { channelID: prefer, attachmentID: own };
    for (const [channelID, byUser] of Object.entries(avatars)) {
      const id = byUser[userID];
      if (id && ready(id)) return { channelID, attachmentID: id };
    }
  }
  if (prefer) {
    const id = avatars[prefer]?.[userID];
    if (id) return { channelID: prefer, attachmentID: id };
  }
  for (const [channelID, byUser] of Object.entries(avatars)) {
    const id = byUser[userID];
    if (id) return { channelID, attachmentID: id };
  }
  return null;
}

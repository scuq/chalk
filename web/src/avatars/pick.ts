// chalk 112-4 -- finding a picture for a surface that has no channel.
//
// A profile picture is encrypted under a CHANNEL key, so it exists once per
// channel and is only readable with that channel's key. The feed and the
// members panel always know which channel they are in. The roster, the hover
// card and a friend row do not: they are about a person, not a room.
//
// So they ask this: given everything known about who has a picture where,
// which (channel, attachment) pair should this surface draw? Any channel
// shared with that person will do -- it is the same face -- and a preferred
// one (the channel on screen) is used when it has an entry, because its key
// and its blob are the ones most likely to be decrypted and cached already.

export interface AvatarPick {
  channelID: string;
  attachmentID: string;
}

/**
 * pickAvatar finds a picture for one user. `prefer` is tried first; otherwise
 * the channels are searched in whatever order the map yields, which is stable
 * for a given state and irrelevant to the result: the picture is the same in
 * every channel, only its ciphertext differs.
 *
 * Returns null when this user has no picture anywhere the caller can see --
 * which is also what a user who has never set one looks like.
 */
export function pickAvatar(
  avatars: Record<string, Record<string, string>>,
  userID: string,
  prefer?: string | null,
): AvatarPick | null {
  if (!userID) return null;
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

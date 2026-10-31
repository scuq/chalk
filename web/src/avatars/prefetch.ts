// 112-10: Choose the DM channels whose pictures the client must still list.

/** A DMChannelLike is the part of a channel summary that dmChannelsToList reads. */
export interface DMChannelLike {
  id: string;
  isDM: boolean;
  memberIDs: string[];
}

/**
 * dmChannelsToList returns the ids of the two-person DM channels whose
 * pictures the client has not asked for yet.
 * It skips each channel that is in `asked`.
 * It does not change `asked`. The caller adds each id after it sends the request.
 */
export function dmChannelsToList(
  channels: Record<string, DMChannelLike>,
  asked: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const ch of Object.values(channels)) {
    if (!ch.isDM || ch.memberIDs.length !== 2) continue;
    if (asked.has(ch.id)) continue;
    out.push(ch.id);
  }
  return out;
}

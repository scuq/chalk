// chalk-web -- the unread badge count.
//
// Not event-driven and not rules-driven: the badge is a pure derivation
// of read-cursor state, recomputed whenever that state changes, and it
// survives do-not-disturb -- DND silences interruptions, the badge is
// the opposite of an interruption.
//
// What counts is "needs you", the line the thread inbox already drew,
// not raw volume: a busy channel you're ignoring on purpose shouldn't
// pin a number to the tab.
//
//   + each DM with something unread        (every DM message is for you)
//   + each channel you were mentioned in
//   + unread threads you're involved in    (the server-computed total)
//   + open friend requests

export interface BadgeInputs {
  unread: Record<string, { lastSeq: number; lastReadSeq: number; mention: boolean }>;
  dmChannelIDs: ReadonlySet<string>;
  threadInboxUnreadTotal: number;
  pendingIncomingCount: number;
}

export function badgeCount(input: BadgeInputs): number {
  let n = 0;
  for (const [channelID, u] of Object.entries(input.unread)) {
    const isUnread = u.lastSeq > u.lastReadSeq;
    if (!isUnread) continue;
    if (input.dmChannelIDs.has(channelID)) n += 1;
    else if (u.mention) n += 1;
  }
  return n + input.threadInboxUnreadTotal + input.pendingIncomingCount;
}

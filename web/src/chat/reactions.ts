// 37-5: turning per-member reaction sets into the row of chips under a message.
//
// The server stores one ENCRYPTED set per (message, reactor) and cannot group
// them -- it has never seen an emoji. So the tally happens here, on decrypted
// sets, which is also why this module is pure: it is the one place the counts
// are derived, and it is worth being able to test it without a channel key.

/** One member's decrypted reaction set for one message. */
export interface ReactionSet {
  userID: string;
  emoji: string[];
}

/** One chip: an emoji, how many people picked it, and whether you did. */
export interface ReactionTally {
  emoji: string;
  count: number;
  mine: boolean;
  /** Reactor user ids, in first-seen order -- for the hover tooltip. */
  userIDs: string[];
}

/**
 * aggregate tallies every member's set into display order.
 *
 * Ordering is by FIRST APPEARANCE across the sets, not by count. Count-ordered
 * chips reshuffle themselves as people react, which makes the one you were
 * about to click move out from under the pointer; stable order does not.
 *
 * Duplicates within one member's set are ignored -- a set is a set, and a
 * malformed or hostile client shouldn't be able to inflate a count.
 */
export function aggregate(
  sets: readonly ReactionSet[],
  selfUserID: string | null | undefined,
): ReactionTally[] {
  const byEmoji = new Map<string, ReactionTally>();
  for (const set of sets) {
    const seen = new Set<string>();
    for (const emoji of set.emoji) {
      if (!emoji || seen.has(emoji)) continue;
      seen.add(emoji);
      let tally = byEmoji.get(emoji);
      if (!tally) {
        tally = { emoji, count: 0, mine: false, userIDs: [] };
        byEmoji.set(emoji, tally);
      }
      tally.count++;
      tally.userIDs.push(set.userID);
      if (selfUserID && set.userID === selfUserID) tally.mine = true;
    }
  }
  return Array.from(byEmoji.values());
}

/**
 * toggle returns the set that should replace `current` when the viewer clicks
 * `emoji`. Adding appends (preserving the order the member picked them in);
 * removing filters.
 *
 * Returning the whole new set rather than an add/remove verb is deliberate:
 * set_reactions replaces the row wholesale, which makes a double-click or a
 * racing second device converge instead of drifting.
 */
export function toggle(current: readonly string[], emoji: string): string[] {
  return current.includes(emoji)
    ? current.filter((e) => e !== emoji)
    : [...current, emoji];
}

/** The viewer's own current set for a message, or [] if they haven't reacted. */
export function ownSet(
  sets: readonly ReactionSet[],
  selfUserID: string | null | undefined,
): string[] {
  if (!selfUserID) return [];
  return sets.find((s) => s.userID === selfUserID)?.emoji ?? [];
}

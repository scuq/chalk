// chalk-web -- which threads need you, and which are merely alive?
//
// Pure and structurally typed, on the classify.ts precedent: this is the part
// that is easy to get subtly wrong and hard to check by hand in a browser, and
// it has no business importing app state.
//
// Three inputs, three different sources, and keeping them apart IS the design:
//
//   * unread    -- server metadata: the thread's newest reply seq vs our cursor
//   * involved  -- server metadata: we wrote the head or a reply, resolved from
//                  the sending device. Needs no plaintext.
//   * mentioned -- CLIENT ONLY. Bodies are ciphertext; the server cannot answer
//                  this and deliberately is not asked to (see migration 0047).
//
// Necessarily incomplete on the mention axis: a mention inside a reply this
// client has never decrypted cannot be known. Involvement is the floor;
// mentions refine it upward where the client can.

// Just enough of an inbox row to decide. The fields the server sends about
// relevance, nothing about presentation.
export interface ThreadRelevanceFacts {
  threadID: string;
  lastReplySeq: number;
  lastReadSeq: number;
  involved: boolean;
}

// isThreadUnread compares the thread's newest reply against our cursor.
//
// seen is state.threadSeen, which may be AHEAD of the row's lastReadSeq: the
// row was built server-side, and an open_thread bump or a thread_read_state push
// can have landed since. Taking the max of the two is what stops a thread the
// user just read from flashing back to unread when the inbox refetches.
export function isThreadUnread(
  row: ThreadRelevanceFacts,
  seen: Record<string, number>,
): boolean {
  const cursor = Math.max(row.lastReadSeq, seen[row.threadID] ?? 0);
  return row.lastReplySeq > cursor;
}

// partitionThreadInbox splits rows into the two groups the panel renders.
//
// "Needs you" is unread AND (involved OR mentioned). A forty-reply thread you
// never touched is active, not yours -- the same call classify.ts already makes
// for notification sounds ("a reply in a thread you have nothing to do with is
// just a message").
//
// Order within each group is preserved: the server already sorted newest-first
// and re-sorting here would only invite the two to disagree.
export function partitionThreadInbox<T extends ThreadRelevanceFacts>(
  rows: T[],
  seen: Record<string, number>,
  mentions: Record<string, boolean>,
): { needsYou: T[]; alsoActive: T[] } {
  const needsYou: T[] = [];
  const alsoActive: T[] = [];
  for (const r of rows) {
    const unread = isThreadUnread(r, seen);
    if (unread && (r.involved || mentions[r.threadID])) needsYou.push(r);
    else alsoActive.push(r);
  }
  return { needsYou, alsoActive };
}

// dedupeThreadRows keeps the first occurrence of each thread id.
//
// The two server halves cannot overlap (the recency cutoff partitions them), but
// a live reply can move a thread from one to the other between fetches, and
// "load more" pages can race a refetch. Deduping here is cheap insurance that
// costs nothing when there is nothing to remove.
export function dedupeThreadRows<T extends { threadID: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    if (seen.has(r.threadID)) continue;
    seen.add(r.threadID);
    out.push(r);
  }
  return out;
}

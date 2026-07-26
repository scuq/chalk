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

// 47-1: how faint a row should read, from how long ago its last reply landed.
//
// Bands, not a continuous ramp. A smooth curve makes two rows an hour apart look
// identical while still costing every row a distinct opacity; discrete steps at
// the boundaries a reader actually thinks in -- ten minutes, an hour, this
// morning, today, this week -- make "still happening" and "yesterday" read as
// different kinds of thing at a glance.
const threadAgeBoundsMS = [
  10 * 60_000, // 10m
  60 * 60_000, // 1h
  2 * 3_600_000, // 2h
  8 * 3_600_000, // 8h
  24 * 3_600_000, // 24h
  7 * 24 * 3_600_000, // 1w
];

// threadAgeStep returns 0 (freshest) through threadAgeBoundsMS.length (oldest).
// A timestamp in the future -- clock skew between us and the sender -- lands on
// 0 rather than going negative.
export function threadAgeStep(ts: Date, now: Date): number {
  const age = now.getTime() - ts.getTime();
  let step = 0;
  for (const bound of threadAgeBoundsMS) {
    if (age < bound) break;
    step++;
  }
  return step;
}

// 47-2: filtering the inbox, client-side.
//
// Client-side is the only option that exists: bodies are ciphertext, so the
// server cannot match on them and is deliberately not asked to. It also means
// the search is honestly limited to what this client holds -- the rows fetched
// so far, and of each thread only the head and the newest reply, since those are
// the only bodies an inbox row carries. Replies in the middle of a thread are
// not searchable from here.

// threadQueryTerms splits a query into lowercased terms. Terms are ANDed, so
// "core deploy" finds a thread in #core about the deploy regardless of the order
// the two words appear in the row.
export function threadQueryTerms(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
}

// threadRowMatches tests one row's searchable text against parsed terms. The
// haystack is built by the caller because the interesting parts -- channel name,
// sender handle -- are resolved from app state, not carried on the row.
export function threadRowMatches(haystack: string, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = haystack.toLowerCase();
  return terms.every((t) => hay.includes(t));
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

// Phase 42-7: the thread-inbox relevance decision.
//
// This is the part that decides what the panel puts under "needs you", so the
// properties that matter are about who gets bothered:
//   * unread + you took part            -> needs you
//   * unread + you were mentioned       -> needs you, even uninvolved
//   * unread + neither                  -> merely active, not yours
//   * read                              -> merely active, whatever else is true
//   * a local cursor ahead of the server's wins, so a thread you just read
//     does not flash back to unread when the inbox refetches

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeThreadRows,
  isThreadUnread,
  partitionThreadInbox,
  threadAgeStep,
  threadQueryTerms,
  threadRowMatches,
  type ThreadRelevanceFacts,
} from "./threadinbox.ts";

function row(over: Partial<ThreadRelevanceFacts> = {}): ThreadRelevanceFacts {
  return {
    threadID: "t1",
    lastReplySeq: 10,
    lastReadSeq: 0,
    involved: false,
    ...over,
  };
}

test("a reply newer than the cursor is unread", () => {
  assert.equal(isThreadUnread(row({ lastReplySeq: 10, lastReadSeq: 9 }), {}), true);
});

test("a cursor at the newest reply is read", () => {
  assert.equal(isThreadUnread(row({ lastReplySeq: 10, lastReadSeq: 10 }), {}), false);
});

test("a local cursor ahead of the server's wins", () => {
  // The row was built server-side; an open_thread bump or a thread_read_state
  // push can have landed since. Without the max, refetching would flash the
  // thread back to unread.
  const r = row({ threadID: "t1", lastReplySeq: 10, lastReadSeq: 4 });
  assert.equal(isThreadUnread(r, { t1: 10 }), false);
});

test("a stale local cursor cannot mask a genuinely unread thread", () => {
  const r = row({ threadID: "t1", lastReplySeq: 10, lastReadSeq: 8 });
  assert.equal(isThreadUnread(r, { t1: 3 }), true);
});

test("unread and involved needs you", () => {
  const { needsYou, alsoActive } = partitionThreadInbox([row({ involved: true })], {}, {});
  assert.equal(needsYou.length, 1);
  assert.equal(alsoActive.length, 0);
});

test("unread and mentioned needs you even when uninvolved", () => {
  // Mentions are the client's half of relevance -- the server cannot compute
  // them, so this is the only place an uninvolved thread becomes urgent.
  const { needsYou } = partitionThreadInbox(
    [row({ threadID: "t1", involved: false })],
    {},
    { t1: true },
  );
  assert.equal(needsYou.length, 1);
});

test("unread but neither involved nor mentioned is merely active", () => {
  // A forty-reply thread you never touched is active, not yours.
  const { needsYou, alsoActive } = partitionThreadInbox([row({ involved: false })], {}, {});
  assert.equal(needsYou.length, 0);
  assert.equal(alsoActive.length, 1);
});

test("a read thread is merely active however involved you are", () => {
  const { needsYou, alsoActive } = partitionThreadInbox(
    [row({ threadID: "t1", lastReplySeq: 5, lastReadSeq: 5, involved: true })],
    {},
    { t1: true },
  );
  assert.equal(needsYou.length, 0);
  assert.equal(alsoActive.length, 1);
});

test("partitioning preserves the server's newest-first order", () => {
  const rows = [
    row({ threadID: "a", involved: true }),
    row({ threadID: "b", involved: true }),
    row({ threadID: "c", involved: true }),
  ];
  const { needsYou } = partitionThreadInbox(rows, {}, {});
  assert.deepEqual(
    needsYou.map((r) => r.threadID),
    ["a", "b", "c"],
  );
});

test("dedupe keeps the first occurrence of a thread", () => {
  const out = dedupeThreadRows([
    { threadID: "a", n: 1 },
    { threadID: "b", n: 2 },
    { threadID: "a", n: 3 },
  ]);
  assert.deepEqual(out, [
    { threadID: "a", n: 1 },
    { threadID: "b", n: 2 },
  ]);
});

test("dedupe returns an equivalent list when there is nothing to remove", () => {
  const rows = [{ threadID: "a" }, { threadID: "b" }];
  assert.deepEqual(dedupeThreadRows(rows), rows);
});

// 47-1: age bands. What matters is that each boundary is a step, and that the
// band is closed at the top -- a reply exactly 10 minutes old is already in the
// older band, not still in the freshest one.
const now = new Date("2026-07-26T12:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);

test("a fresh reply sits in the brightest band", () => {
  assert.equal(threadAgeStep(ago(0), now), 0);
  assert.equal(threadAgeStep(ago(9 * 60_000), now), 0);
});

test("each threshold moves the row one band fainter", () => {
  assert.equal(threadAgeStep(ago(10 * 60_000), now), 1);
  assert.equal(threadAgeStep(ago(60 * 60_000), now), 2);
  assert.equal(threadAgeStep(ago(2 * 3_600_000), now), 3);
  assert.equal(threadAgeStep(ago(8 * 3_600_000), now), 4);
  assert.equal(threadAgeStep(ago(24 * 3_600_000), now), 5);
  assert.equal(threadAgeStep(ago(7 * 24 * 3_600_000), now), 6);
});

test("age saturates at the oldest band", () => {
  assert.equal(threadAgeStep(ago(365 * 24 * 3_600_000), now), 6);
});

test("a timestamp from the future is treated as fresh, not inverted", () => {
  // Clock skew between us and the sending device. Better to read as new than to
  // fall out of the band range.
  assert.equal(threadAgeStep(ago(-60_000), now), 0);
});

// 47-2: the filter.
test("an empty query matches everything", () => {
  assert.deepEqual(threadQueryTerms(""), []);
  assert.deepEqual(threadQueryTerms("   "), []);
  assert.equal(threadRowMatches("anything", []), true);
});

test("matching is case-insensitive in both directions", () => {
  assert.equal(threadRowMatches("Feature Requests", threadQueryTerms("FEATURE")), true);
  assert.equal(threadRowMatches("FEATURE REQUESTS", threadQueryTerms("feature")), true);
});

test("terms are ANDed and order-independent", () => {
  const hay = "[CORE] General blade the deploy broke again";
  assert.equal(threadRowMatches(hay, threadQueryTerms("deploy blade")), true);
  assert.equal(threadRowMatches(hay, threadQueryTerms("blade deploy")), true);
  assert.equal(threadRowMatches(hay, threadQueryTerms("blade rollback")), false);
});

test("terms match inside words", () => {
  // Substring, not word-prefix: half-typed queries should narrow as you type.
  assert.equal(threadRowMatches("rollback", threadQueryTerms("ollb")), true);
});

test("extra whitespace in a query is not a term", () => {
  assert.equal(threadRowMatches("general", threadQueryTerms("  general  ")), true);
});

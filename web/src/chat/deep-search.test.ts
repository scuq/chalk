// Phase 61-3: the full-history crawl's loop invariants.
//
// The properties that matter:
//   * the cursor comes from the crawl's own pages, so concurrent scrollback
//     can neither skip nor repeat ranges
//   * completion is inferred against the requested limit, not scrollback's 50
//   * a page in flight when the crawl is stopped is still delivered
//   * failures end the crawl as "error", never as a false "done"
//   * undecryptable rows are counted, deleted rows are not

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runDeepSearch,
  withTimeout,
  type DeepPageRow,
  type DeepSearchProgress,
} from "./deep-search.ts";
import { PLACEHOLDER_FAILED } from "../crypto/channel-crypto.ts";

function row(seq: number, over: Partial<DeepPageRow> = {}): DeepPageRow {
  return { seq, ts: new Date(seq * 1000), body: `msg ${seq}`, ...over };
}

// Newest-first, like the server sends: seqs from `hi` down to `lo`.
function page(hi: number, lo: number): DeepPageRow[] {
  const rows: DeepPageRow[] = [];
  for (let s = hi; s >= lo; s--) rows.push(row(s));
  return rows;
}

interface Run {
  fetches: { beforeSeq: number; limit: number }[];
  pages: { count: number; complete: boolean }[];
  progress: DeepSearchProgress[];
  last: DeepSearchProgress;
}

async function run(
  pages: (DeepPageRow[] | Error)[],
  opts: { startBeforeSeq?: number | null; pageLimit?: number; signal?: AbortSignal } = {},
): Promise<Run> {
  const out: Run = { fetches: [], pages: [], progress: [], last: undefined as never };
  let i = 0;
  await runDeepSearch({
    startBeforeSeq: opts.startBeforeSeq ?? null,
    pageLimit: opts.pageLimit ?? 3,
    signal: opts.signal ?? new AbortController().signal,
    fetchPage: (beforeSeq, limit) => {
      out.fetches.push({ beforeSeq, limit });
      const p = pages[i++] ?? [];
      return p instanceof Error ? Promise.reject(p) : Promise.resolve(p);
    },
    onPage: (rows, complete) => out.pages.push({ count: rows.length, complete }),
    onProgress: (p) => out.progress.push(p),
  });
  out.last = out.progress[out.progress.length - 1]!;
  return out;
}

test("a short page completes the crawl", async () => {
  const r = await run([page(10, 9)], { startBeforeSeq: 11 });
  assert.deepEqual(r.fetches, [{ beforeSeq: 11, limit: 3 }]);
  assert.deepEqual(r.pages, [{ count: 2, complete: true }]);
  assert.equal(r.last.phase, "done");
  assert.equal(r.last.scanned, 2);
});

test("the cursor advances from the crawl's own pages", async () => {
  const r = await run([page(10, 8), page(7, 5), page(4, 4)], { startBeforeSeq: 11 });
  assert.deepEqual(
    r.fetches.map((f) => f.beforeSeq),
    [11, 8, 5],
  );
  assert.equal(r.last.phase, "done");
  assert.equal(r.last.scanned, 7);
});

test("history never fetched starts from the newest page", async () => {
  const r = await run([page(2, 1)], { startBeforeSeq: null });
  assert.deepEqual(r.fetches, [{ beforeSeq: 0, limit: 3 }]);
  assert.equal(r.last.phase, "done");
});

test("an exactly-full last page costs one extra empty fetch, then done", async () => {
  const r = await run([page(3, 1), []], { startBeforeSeq: 4 });
  assert.equal(r.fetches.length, 2);
  // The empty page is complete but never delivered -- there is nothing to merge.
  assert.deepEqual(r.pages, [
    { count: 3, complete: false },
    // (no second entry)
  ]);
  assert.equal(r.last.phase, "done");
  assert.equal(r.last.scanned, 3);
});

test("oldestTS tracks the oldest row seen so far", async () => {
  const r = await run([page(10, 8), page(7, 7)], { startBeforeSeq: 11 });
  assert.equal(r.last.oldestTS?.getTime(), 7000);
});

test("undecryptable rows are counted; deleted tombstones are not", async () => {
  const rows = [
    row(3, { body: PLACEHOLDER_FAILED }),
    row(2, { body: PLACEHOLDER_FAILED, deleted: true }),
    row(1),
  ];
  const r = await run([rows], { startBeforeSeq: 4 });
  assert.equal(r.last.undecryptable, 1);
  assert.equal(r.last.phase, "done");
});

test("an already-aborted signal stops before any fetch", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const r = await run([page(3, 1)], { startBeforeSeq: 4, signal: ctrl.signal });
  assert.equal(r.fetches.length, 0);
  assert.equal(r.last.phase, "stopped");
});

test("aborting mid-flight still delivers the fetched page, then stops", async () => {
  const ctrl = new AbortController();
  const out: Run = { fetches: [], pages: [], progress: [], last: undefined as never };
  await runDeepSearch({
    startBeforeSeq: 8,
    pageLimit: 3,
    signal: ctrl.signal,
    fetchPage: (beforeSeq, limit) => {
      out.fetches.push({ beforeSeq, limit });
      ctrl.abort(); // the user clicks stop while the page is in flight
      return Promise.resolve(page(7, 5));
    },
    onPage: (rows, complete) => out.pages.push({ count: rows.length, complete }),
    onProgress: (p) => out.progress.push(p),
  });
  assert.deepEqual(out.pages, [{ count: 3, complete: false }]);
  assert.equal(out.progress[out.progress.length - 1]!.phase, "stopped");
  assert.equal(out.fetches.length, 1);
});

test("a fetch failure ends the crawl as an error, keeping progress so far", async () => {
  const r = await run([page(10, 8), new Error("timed out")], { startBeforeSeq: 11 });
  assert.equal(r.last.phase, "error");
  assert.equal(r.last.error, "timed out");
  assert.equal(r.last.scanned, 3);
});

test("a full page that does not move the cursor is an error, not a loop", async () => {
  const r = await run([page(10, 8), page(10, 8)], { startBeforeSeq: 11 });
  assert.equal(r.fetches.length, 2);
  assert.equal(r.last.phase, "error");
});

test("withTimeout rejects a promise that never settles", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 10),
    /timed out/,
  );
});

test("withTimeout passes through a settled value", async () => {
  assert.equal(await withTimeout(Promise.resolve(7), 1000), 7);
});

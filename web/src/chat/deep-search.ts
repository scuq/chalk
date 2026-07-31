// chalk-web -- the full-history search crawl.
//
// 61-3. Instant search (search.ts) sees only what this client holds; this is
// the part that makes "search the whole channel" true. It pages fetch_history
// backwards from where local history ends to the channel's first message,
// decrypting as it goes -- the server holds ciphertext and cannot do any of
// this. That cost is why the crawl starts only from an explicit click,
// reports progress after every page, and stops the moment it is told to.
//
// Pure-async with injected I/O, on the history-paging.ts precedent: the loop
// invariants (cursor advance, completion inference, abort behaviour) are the
// part that is easy to get subtly wrong, so they live here where a fake
// fetchPage can exercise them under node:test. App wires the real transport:
// WSClient.request() + decryptAll. Correlated request() acks bypass the
// global fetch_history_ack handler, so a crawl never trips the scrollback
// paging guards or its page-size-50 completion inference.

import { isUndecryptableBody } from "./search";

// 4x the scrollback page: fewer round trips matter more than smooth progress
// updates here, and the server clamps at 200 anyway.
export const DEEP_PAGE_LIMIT = 200;

// A request() waiter is never rejected if the socket dies under it, so every
// page fetch is raced against this. Generous: a page is ~200 rows of
// ciphertext through one query.
export const DEEP_PAGE_TIMEOUT_MS = 15_000;

export interface DeepSearchProgress {
  // Rows fetched by THIS crawl. Counts pages, not unique messages -- a row
  // scrollback happened to load too is merged away by the store but still
  // scanned here. Cosmetic either way.
  scanned: number;
  // Rows this device could not decrypt (key epoch never held here). Counted,
  // not fixed: surfacing an honest "except these N" beats pretending the
  // crawl read everything.
  undecryptable: number;
  // How far back the crawl has reached, for "back to <date>" display.
  oldestTS: Date | null;
  phase: "running" | "done" | "stopped" | "error";
  error?: string;
}

// The slice of a decrypted message the crawl itself needs.
export interface DeepPageRow {
  seq: number;
  ts: Date;
  body: string;
  deleted?: boolean;
}

export interface DeepSearchOpts<T extends DeepPageRow> {
  // Oldest locally-held seq, i.e. where local history ends and the crawl
  // starts. null = channel history never fetched; before_seq 0 asks the
  // server for the newest page.
  startBeforeSeq: number | null;
  // Resolves to DECRYPTED rows, newest-first as the server sends them.
  // Rejections (error ack, timeout, closed socket) end the crawl.
  fetchPage: (beforeSeq: number, limit: number) => Promise<T[]>;
  // Called per page BEFORE the progress update; the caller merges the rows
  // into the store (history_loaded), which is what streams results into an
  // open search panel. complete mirrors what the caller should pass along.
  onPage: (rows: T[], complete: boolean) => void;
  onProgress: (p: DeepSearchProgress) => void;
  signal: AbortSignal;
  pageLimit?: number;
}

// withTimeout races a promise against the page timeout. Exported for the
// caller building fetchPage.
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function runDeepSearch<T extends DeepPageRow>(
  opts: DeepSearchOpts<T>,
): Promise<void> {
  const limit = opts.pageLimit ?? DEEP_PAGE_LIMIT;
  const progress: DeepSearchProgress = {
    scanned: 0,
    undecryptable: 0,
    oldestTS: null,
    phase: "running",
  };
  // The cursor advances from the crawl's OWN pages only, never re-read from
  // app state -- concurrent scrollback paging moves the store's oldest row,
  // and following it would skip or repeat ranges.
  let before = opts.startBeforeSeq ?? 0;

  for (;;) {
    if (opts.signal.aborted) {
      opts.onProgress({ ...progress, phase: "stopped" });
      return;
    }
    let rows: T[];
    try {
      rows = await opts.fetchPage(before, limit);
    } catch (e) {
      opts.onProgress({
        ...progress,
        phase: "error",
        error: e instanceof Error ? e.message : String(e),
      });
      return;
    }

    // Completion against the REQUESTED limit -- the shared scrollback path
    // infers against its own page size of 50, which would be wrong here.
    const complete = rows.length < limit;

    progress.scanned += rows.length;
    let minSeq = 0;
    for (const m of rows) {
      if (!m.deleted && isUndecryptableBody(m.body)) progress.undecryptable++;
      if (m.seq > 0 && (minSeq === 0 || m.seq < minSeq)) {
        minSeq = m.seq;
        progress.oldestTS = m.ts;
      }
    }

    // The page is delivered even when the crawl was aborted while it was in
    // flight: the rows are already decrypted and the store merge is the same
    // one scrollback does -- throwing them away helps nobody.
    if (rows.length > 0) opts.onPage(rows, complete);

    if (opts.signal.aborted) {
      opts.onProgress({ ...progress, phase: "stopped" });
      return;
    }
    if (complete) {
      opts.onProgress({ ...progress, phase: "done" });
      return;
    }
    if (minSeq === 0 || (before > 0 && minSeq >= before)) {
      // A full page that did not move the cursor backwards can only loop
      // forever; treat a misbehaving server as the end of the road.
      opts.onProgress({ ...progress, phase: "error", error: "history cursor stuck" });
      return;
    }
    opts.onProgress({ ...progress });
    before = minSeq;
  }
}

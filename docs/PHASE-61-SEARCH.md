# Phase 61 — Message search (instant + deep full-history)

## Context

chalk has no way to find an old message. Because the app is E2E-encrypted,
the server only ever holds ciphertext — search **must** run client-side over
decrypted plaintext. The client already holds a decrypted corpus in
`state.messages` (per-channel, in-memory, grown by scrollback paging), so an
instant search over "what's loaded" is nearly free. For anything older, the
client must fetch + decrypt history itself; that is expensive, so it happens
only after an explicit click, with live progress and a Stop button.

Decisions:

- **Modal overlay panel** (ThreadInboxPanel pattern, `openPanel` slot
  extended with `"search"`), opened by a channel-header button and
  **Ctrl/Cmd+K**.
- Two instant scopes: **current channel** (default) and **all fetched
  channels**. Instant = re-filter on every keystroke, no fetching.
- **Deep mode**: per-channel "search full history" — one confirm click,
  pages backwards to the channel beginning, streams results in, cancellable,
  progress shown. Never starts on its own.
- Clicking a result jumps to + flashes the message (existing 49-1
  mechanism).

**Zero server changes.** `fetch_history` (limit ≤ 200, membership-checked)
already provides everything deep search needs.

## Key design facts (verified in code)

- `WSClient.request()` (`web/src/ws-client.ts:101`) gives ref-correlated
  request/response; matching acks are settled and **not** forwarded to
  `opts.onFrame`. Deep-search pages fetched via
  `request(TypeFetchHistory, …)` therefore bypass the global ack handler in
  App.tsx — no collision with the scrollback guard `olderInFlightRef`, and
  no wrong `pageMarksComplete` inference (which assumes page size 50).
- Hazard: pending `request()` waiters are **never rejected** on socket close
  (`ws-client.ts` `onClose`) — a page in flight during a disconnect hangs
  forever. Mitigated with a ~15 s timeout race per page + `isOpen()` check
  before each. (A ws-client fix is out of scope; flagged below.)
- `set_active_channel` nulls `openThread` but NOT `openPanel` — result
  clicks must dispatch `close_panel` explicitly.
- Thread replies never render in the main feed (`!m.parentID` filter), so a
  reply result opens its thread via `open_thread_from_inbox` (atomic
  channel-switch + thread-open) instead of flashing.
- Decrypt placeholders are consts in `channel-crypto.ts`
  (`PLACEHOLDER_NO_KEY` uses an em-dash `—`). They are exported and
  imported — never retyped.
- Body sentinels: giphy bodies are sentinel+URL (no user text);
  link-preview bodies embed JSON before the text (`parseLinkPreviewBody`).
  Search extracts the real haystack rather than substring-matching the raw
  body (JSON keys would false-match).
- Old key epochs decrypt only if this device holds that space-key version in
  IndexedDB; deep search **counts and skips** undecryptable rows ("N
  messages couldn't be decrypted") — key-wrap backfill is out of scope.
- Reducer `history_loaded` merges by id + re-sorts by seq + raise-only
  `historyComplete` — deep-search pages dispatched through it stream into
  the store and the panel's memo re-filters reactively for free.
- Reused machinery: `threadQueryTerms` (`chat/threadinbox.ts`) for term
  parsing; the 49-1 flash (`flashMessage` state + `MessageList`
  `flashMessageID`/`onFlashDone`); ThreadInboxPanel row/Escape/skeleton
  patterns; mobile full-bleed modal CSS is already global.

## Slice 61-1 — pure search module + tests

`web/src/chat/search.ts` (pure, no DOM, structural types):

- `interface SearchableMessage` — structural subset of `Message` (id,
  channelID, seq, senderUserID, ts, body, deleted?, parentID?, threadID?).
- `searchableText(body): string | null` — null for deleted rows and the
  three placeholder bodies; giphy → bare URL; link-preview → parsed text +
  preview title/description/site_name/url (never the raw JSON).
- `isUndecryptableBody(body): boolean` — placeholder check, used by deep
  search's counter.
- `searchMessages(messagesByChannel, scope, terms, labels, cap?)` →
  `{ results, total }` — scope `{kind:"channel", channelID} | {kind:"all"}`;
  haystack = searchable text + sender handle + channel name; AND over
  lowercased terms; newest-first; `SEARCH_RESULT_CAP = 200` rendered,
  `total` = full count. Empty terms → empty results.
- `snippetSegments(text, terms, maxLen?)` → `{text, hit}[]` — ~160-char
  window centred on the first hit, so the panel renders `<mark>` without
  regex in JSX.

Plus: export the `PLACEHOLDER_*` consts from `channel-crypto.ts`; node:test
suite in `search.test.ts` (sentinel extraction, placeholder/deleted
skipping, AND semantics, scopes, ordering, cap + total, snippets, empty
query).

## Slice 61-2 — SearchPanel + Ctrl/Cmd+K + jump-to-result

- `types.ts` / `reducer.ts`: add `"search"` to the `openPanel` union and the
  `open_panel` case. Query/scope stay component-local.
- `SearchPanel.tsx` — modeled on ThreadInboxPanel (modal card, own width
  class, Escape clears query first then closes, autofocus, one `new Date()`
  per render). `useMemo` → `searchMessages`. Row: meta line (channel,
  sender, relative time, "in thread" tag) + snippet with
  `<mark class="chalk-search-hit">`. Cap notice "showing first 200 of N".
- `App.tsx`: lazy registration + render site; header search button;
  global Ctrl/Cmd+K toggle (works from typing targets on purpose;
  `preventDefault` is mandatory); `onOpenSearchResult` = `close_panel`, then
  `open_thread_from_inbox` for replies or `set_active_channel` +
  `setFlashMessage` for feed messages.
- `theme.css`: `.chalk-search-panel` width, row/meta/snippet classes,
  `.chalk-search-hit` accent.

## Slice 61-3 — deep search (full-history crawl)

`web/src/chat/deep-search.ts` — pure-async loop with injected I/O:

- `DEEP_PAGE_LIMIT = 200`, `DEEP_PAGE_TIMEOUT_MS = 15_000`.
- `DeepSearchProgress { scanned; undecryptable; oldestTS;
  phase: running|done|stopped|error; error? }`.
- `runDeepSearch({ startBeforeSeq, fetchPage, onPage, onProgress, signal })`
  — invariants: `before_seq` advances from the loop's **own** pages (min seq
  returned), never re-read from app state, so concurrent scrollback can't
  skip or repeat ranges; `complete = rows.length < limit` against the
  **requested** limit; NOT `heads_only` (replies must be searchable); stop
  on short page / abort / rejection or timeout; progress after every page.

App wiring: `fetchPage` = `withTimeout(c.request(TypeFetchHistory, …))` →
`decryptAll(wireToMessage…)`; `onPage` dispatches `history_loaded` (store
merge streams results into the open panel; memory grows exactly as normal
scrollback would; the skipped mention-scan is harmless for old rows). Abort
on Stop, panel close, channel switch, logout/teardown. Panel footer:
"Search full history" (hidden once `historyComplete`), running progress
("scanned N messages · back to <date>") + Stop, done / undecryptable-count /
error states; after an error the button resumes from the new oldest local
seq.

## Out of scope / flagged

- ws-client: rejecting pending `request()` waiters on socket close (proper
  fix for the hang hazard).
- Old-epoch key-wrap backfill (undecryptable rows are counted, not fixed).
- In-thread flash for reply results (thread opens, no highlight) — possible
  61-4.
- Per-keystroke linear scan is fine to ~100k messages; index/debounce only
  if real channels outgrow that.

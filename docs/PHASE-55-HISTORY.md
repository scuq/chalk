# Phase 55 — scrollback: paging the main feed

Fixes the "history stops at 21:23" report (2026-07-30). Planned against
v0.4.5.

## The problem

Opening a channel fetches the newest 50 rows exactly once (`App.tsx`,
`limit: 50`) and nothing in the main feed ever pages backwards — the only
`before_seq` caller is the 49-1 jump-to-message crawl. The server page
includes thread replies (`ListMessagesByChannel` has no parent filter), but
the feed renders only heads (`.filter((m) => !m.parentID)`). In a
thread-heavy channel a single lively thread eats most of the page: four
heads carrying 34 replies leave a feed minutes deep, no scrollbar, and no
way to reach the older history that is sitting untouched on the server.

Nothing is lost; the window is just starved and unreachable. Latent since
threads shipped (42/49) — it bites in proportion to thread usage, which is
why it surfaced right after the crew fell in love with threads.

## What already works for us

- The wire supports paging: `fetch_history {channel_id, before_seq, limit}`.
- The reducer's `history_loaded` merges pages by id and re-sorts by seq, so
  extra pages just grow the window — proven daily by the 49-1 crawl,
  decryption pipeline included.
- `fetch_history` is only ever a *channel* page (threads have their own
  `fetch_thread` frame), so its ack can carry pagination state without
  ambiguity.

## Design

- **Trigger: a top sentinel, not a scroll handler.** An
  IntersectionObserver on a sentinel row above the oldest message. Covers
  both cases with one mechanism: scrolled-to-top fires it, and a feed too
  short to scroll at all (the screenshot case) leaves the sentinel visible,
  so it auto-fills page after page until the feed overflows the viewport or
  history completes.
- **Runaway bound.** A reply-only stretch can add zero visible rows per
  page, leaving the sentinel visible indefinitely. After 3 consecutive
  auto-pages that add no visible heads, stop auto-filling and render a
  manual "load older" button instead — same bounded-crawl spirit as 49-1's
  20-page cap. A click resets the counter.
- **End of history:** a page returning fewer rows than requested marks the
  channel complete — new reducer state `historyComplete:
  Record<channelID, boolean>`, set from the ack. The ack doesn't echo the
  limit, so all main-feed requests use one `HISTORY_PAGE_SIZE = 50`
  constant and the App-side handler compares against it. Initial fetches
  (no `before_seq`) may also mark complete — a channel with fewer than 50
  rows total IS complete. Sticky for the session; live messages append at
  the bottom and never un-complete it.
- **One page in flight per channel** (ref in App, cleared on ack), so a
  jittery observer can't stack requests.
- **Scroll must not jump on prepend.** Manual restoration (Safari has no
  `overflow-anchor`): record the scroll parent's `scrollHeight` before the
  merge renders, then `scrollTop += delta` after. Respect MessageList's
  Anchor contract — while loading older pages the user owns the view
  (`anchorRef` null), and prepending must keep the same rows on screen.
- **UI:** the sentinel row is a spinner while a page is in flight; when
  `historyComplete`, a quiet "— beginning of channel —" cap replaces it,
  so the end of scrollback is stated rather than implied.
- **Untouched:** the 33-4 frozen unread window and divider (seq-based,
  indifferent to prepends), mention backfill, and the 49-1 crawl (it gets
  `historyComplete` for free via the shared ack path, which also ends its
  "deleted so hard the tombstone is gone" case cleanly).

## Slices

- **55-1 — scroll-up pagination** (client only). Reducer:
  `historyComplete` + tests. MessageList: sentinel + observer + scroll
  restoration + the two sentinel states. App: `onLoadOlder(cid, oldestSeq)`
  with the in-flight guard; ack handler computes `complete`. The auto-fill
  damping logic as a pure helper with tests. Changelog. *Done: a
  thread-heavy channel reaches arbitrary depth; no visual jump on prepend;
  "beginning of channel" shows in a small channel immediately.*
- **55-2 — heads-only pages** (server + client). `fetch_history` gains
  `heads_only` (bool, default false → byte-compatible both directions);
  store variant adds `AND m.parent_id IS NULL`. Only the *paging* requests
  (`before_seq` set) send it, so every fetched page is 50 visible rows.
  The **initial** page deliberately stays full: it feeds the 33-3 mention
  scan (a reply can mention you) and warms the newest threads — and any
  starvation of the first page is now healed by 55-1's auto-fill. The 49-1
  crawl also stays full (its target may sit among replies). Head rows keep
  carrying the 42-3 thread decorations, so heads-only pages still hydrate
  reply counts, snippets, and cursors. *Done: paging a reply-heavy channel
  advances ~50 heads per page instead of ~50 rows.*

Order matters: 55-1 is the fix, 55-2 is efficiency on top. 55-1 alone
resolves the report.

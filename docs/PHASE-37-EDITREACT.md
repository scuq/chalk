# Phase 37 — edit and react

*Backfilled record.* Written after the fact from the commit history and the
changelog; the design notes are as-built, not a contemporaneous plan.

**Status:** shipped, v0.3.27 / v0.3.28. Extended by 58 (edit any recent message)
and 75 (who reacted).
**Tag:** `#reactions` → `tools/where.sh -g reactions`

## Why

Two features that look similar and were deliberately given different rules.

**Editing** is author-only, with a 15-minute window from send. There is no owner
override and no vote, on purpose: deleting is a moderation action a channel can
legitimately have opinions about (phase 35), but putting words in someone's
mouth is not. A deleted message cannot be edited back into existence.

**Reactions** are end-to-end encrypted like everything else, and stored *per
user* — the server holds one encrypted set per reactor rather than a plaintext
tally it could count. The visible tally is computed on the client from the sets
it can decrypt.

## What landed

- **37-1** — `edited_at` column, `EditMessage` store primitive, wire-timestamp
  message lookup.
- **37-2** — `edit_message` frames, sender-only 15-minute policy,
  `message_edited` push.
- **37-3** — cursor-up edits the last message; row menu; `(edited)` marker.
- **37-4** — encrypted per-user reaction sets, frames and handlers.
- **37-5** — reaction chips, local tally, history backfill as you scroll back.
- **37-6** — react button in the row actions, `r` shortcut while hovering.

## Where it lives

`web/src/chat/editpolicy.ts`, `web/src/chat/reactions.ts`,
`web/src/components/ReactionBar.tsx`, `web/src/state/reducer.ts`
(and `reducer-reactions.test.ts`), `web/src/components/MessageList.tsx`.

## Notes

- The 15-minute window is enforced client-side *and* by the server's send-time
  check; `editpolicy.ts` is the single place the rule is written.
- 58-1 later fixed the row menu so "edit" appears on every own message still
  inside the window, not only the most recent one.

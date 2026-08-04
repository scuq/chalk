# Phase 87 — message reminders: bringing one line back later

A way to say "not now, but don't let me lose this" about a single message,
without answering it, copying it somewhere, or leaving the channel unread as a
to-do list. Designed against v0.7.2. **NOT IMPLEMENTED — no code exists.** This
document is the plan and nothing below it has been built.

**Status:** design only, written 4 August 2026 from a design session.
**Tag:** `#reminders` → `tools/where.sh -g reminders` (which today finds this
file and nothing else, because there is nothing else).

## The problem

A message lands while you are in the middle of something. It needs twenty
minutes you do not have, or an answer you cannot give until Monday, or a
decision that belongs to a calmer version of you. chalk offers three places to
put it and all three are wrong:

- **Leave the channel unread.** This works exactly once. The second time, the
  unread dot means "one of these two things needs you and you no longer know
  which", and by the fourth it means nothing at all. Unread is a *reading*
  cursor; using it as a task list destroys the thing it was for.
- **Open a thread.** Threads (42/47/49) move the conversation somewhere else and
  tell everyone you did. "I will get to this on Saturday" is not a conversation
  and does not deserve a room.
- **Park it.** The parking lot (53) hides *everything*. It is a state you are in,
  not a mark on a message.

What is missing is small and private: a note to yourself attached to one line,
with a time on it. Nobody else's problem, nobody else's business — and
emphatically not a thing to be answered later by writing "bump" into the
channel, which is how every group chat without this feature ends up working.

## What it is

A **reminder** is a private record saying "show me this message again at T".

Set it from the message's row menu, on your own message or anybody else's, with
one of four choices: **in 1 hour**, **in 24 hours**, **this weekend**, or a time
you pick. When T arrives chalk tells you, and a **Reminders** entry in the
sidebar — directly above the parking lot, below the friends list — carries a
badge until you have dealt with it.

### Decided in the design session

- **The server never learns a reminder exists.** Not the message, not the time,
  not the count. This is the decision every other one falls out of, and it is
  argued in *The record* below.

- **Anyone's message, including your own.** Reminding yourself about something
  *you* said — a promise made, a question asked that nobody answered — is at
  least as common as reminding yourself about someone else's. So the menu item is
  a capability check, not an ownership test, exactly as reactions are; there is
  no `RemindPolicy` module beside `editpolicy.ts` because there is no policy to
  express.

- **Private, and only ever private.** Sharing a reminder was considered for about
  a minute: "remind Bob about this" is a different feature with a different name
  and a consent problem attached, and building it through the same record would
  have forced the due time into the open. Rejected.

- **Weekend means Saturday 09:00 local**, rolling to the following Saturday when
  it is already the weekend. The alternative — Friday 18:00, "when the week is
  over" — reads better as a phrase and worse as a time: it puts the thing you
  were avoiding in front of you at the exact moment you stopped working. And a
  "weekend" preset that fires in ten minutes because you set it on a Saturday
  morning is a bug the user experiences as chalk not understanding words.

- **Fired is not done.** A reminder that has gone off stays in the list, with the
  badge lit, until you say otherwise — jump to it, snooze it, or mark it done.
  Clearing on sight was rejected for the reason unread already taught us: a
  counter that zeroes itself when glanced at stops meaning anything. Snooze is
  the honest verb for what people actually do.

## The record

**Reminders ride the sealed prefs blob.** One flat key, `reminders_enc`, holding
the whole set as AES-256-GCM ciphertext under a key derived by HKDF-SHA256 from
the identity's X25519 private scalar — `web/src/crypto/prefs-blob.ts`
(`scalarFromX25519:39`, `blobKey:50`, `sealJSON:69`, `openJSON:83`), with its own
salt/info pair `chalk-reminders-salt-v1` / `chalk-reminders-v1` so the key is
independent of every other use of that scalar.

This is a rail three features already run on: the notification rules (50-6,
`notify/rules-sync.ts`), the per-peer audio list (66-3,
`voice/peer-audio-sync.ts`) and the identity pins (84-1, `crypto/pin-backup.ts`).
Every device that can read messages derives the same key, so cross-device sync
and the `prefs_changed` fan-out come for free.

What follows from it:

- **No migration, no wire frames, no server code.** Phase 86's reserved
  `migrations/0051_message_ties.sql` stays reserved; phase 87 does not take a
  migration number because it does not have a table. `go build` output is
  byte-identical before and after this phase.
- **The server sees an opaque prefs key change**, indistinguishable from a
  notification-rule edit. It does not learn that a reminder exists, which message
  it points at, or when it is due.
- **The client fires reminders.** Nothing can go off while chalk is closed; an
  overdue reminder is waiting the moment you open it.

### Rejected: a `message_reminders` table

The obvious build is 0045's reactions shape — one row per (message, user), body
sealed, composite FK into the partitioned `messages` table — with
`sealJSONForChannel` swapped for the identity-scalar seal. It is unbounded, it
gets tombstone cascade for free, and it is the pattern phase 86 already chose for
ties.

It also hands the server *"user X marked message Y at time T"* for every reminder
anyone sets. That is a sharper signal than the reaction leak it would be modelled
on: a reaction says "X responded to Y", which is roughly what a channel is for,
while a reminder says "this specific line is the one X could not deal with" —
attention rather than participation. Multiplied across a workplace it is a decent
map of who is overloaded and by whom. The sealed blob costs a size ceiling and
buys the server knowing nothing.

### Rejected: `sealJSONForChannel`

Right for ties (86), which are shared and attributed. Wrong here: every channel
member holds the space key, so a reminders row sealed under it would be readable
by the channel, and the only thing standing between them and it would be a
server-side `WHERE user_id = $me`. Privacy enforced by a query filter is not
privacy. `crypto/channel-crypto.ts:891` is not the primitive this phase wants.

### Rejected: firing on the server

A janitor loop past a `due_at` column, pushing a frame — chalkd already has six
of these (`EphemeralJanitorLoop`, `runGovernanceSweeper`, the session and invite
janitors), so it would be cheap and it would work on a device that was asleep.

It needs the due time in plaintext. That is the exact leak the whole design
exists to avoid, and it is a *worse* one than the table above, because a due time
is a statement about the future: "X intends to deal with this on Monday at 09:00"
is scheduling information about a person, not about a message. If reminders ever
need to reach a closed client, that is a phase-65 (web push) conversation with
its own opt-in and its own `docs/threat-model.md` line — not a quiet column here.

### The records

```ts
interface Reminder {
  id: string;            // crypto.randomUUID(), client-minted
  channelID: string;
  messageID: string;
  messageTS: number;     // epoch ms, the wire ts
  seq: number | null;    // the jump's stop condition, below
  dueAt: number;
  createdAt: number;
  updatedAt: number;     // the merge's ordering key
  firedAt: number | null;
  doneAt: number | null;
  preview?: string;      // <= PREVIEW_MAX chars, sealed with the rest
}
```

Epoch milliseconds throughout, matching every other time on the wire
(`internal/proto/frames.go:300`, `web/src/proto.ts:367`). `seq` rides along for
the same reason phase 86 carries it: the jump's backfill crawl needs a stop
condition, and it is server-supplied metadata already.

`preview` is the one judgement call worth stating. The Reminders panel is the
whole point of the feature and it is often opened days after the message left the
loaded window, so without a cached preview it would read "alice in #dev, 3 Aug
14:02" and make you jump to find out whether you care. It is sealed with
everything else and the message is on this device anyway, so it leaks nothing —
but it *does* mean a deleted message's text could outlive its tombstone, which is
what the teardown rule below exists to prevent.

### Merge, not last-write-wins

Both directions go through `mergeReminders`, on `crypto/pin-sync.ts:1-16`'s
reasoning: a device whose localStorage was just cleared holds nothing, and
last-write-wins would have it upload that emptiness over the set every other
device depends on.

The rule is a total order over any two records with the same `id`:

- higher `updatedAt` wins;
- on a tie, the record with `doneAt` set wins.

Done being sticky is what stops a stale device resurrecting a reminder you
dismissed — the failure mode that makes people stop trusting a to-do list.

### The ceiling, stated plainly

`prefsMaxBytes = 8 * 1024` (`internal/server/ws.go:2821`) caps a prefs patch, and
pin-backup's `BLOB_BUDGET_BYTES = 7900` is the working budget one blob gets. A
packed reminder carrying a 60-character preview is roughly 170 bytes, so the blob
holds **about 35 reminders**, or about 50 without previews.

That is a real limit and it must never be hit silently. `REMINDER_MAX = 50` is
enforced where a reminder is *set*, with a plain message ("50 reminders is the
limit — clear a few"), and `fitReminders` — modelled on `fitPins`
(`pin-backup.ts:314`) — is the safety net behind it, dropping previews first and
the furthest-out records last. `pruneReminders` clears done records older than
seven days, which in practice keeps anyone from reaching the cap at all.

If reminders turn out to be something people keep hundreds of, that is the signal
to revisit the table decision above — with the leak argued again, not assumed
away.

## Firing

**A module singleton with its own clock**, on `chat/typing-store.ts`'s shape and
for its stated reason: the reducer is pure and cannot hold a timer, and driving
expiry from a dispatch would rebuild `AppState` on every tick forever. `sweep(nowMs)`
takes the clock as a parameter — the single thing that makes it testable without
fake timers — and the interval only runs while something is pending, `unref()`'d
so `node --test` does not hang.

**Deadlines are recomputed from `Date.now()` deltas, never by counting ticks.**
A hidden tab's timers are clamped to about one a minute and a slept or frozen one
stops firing altogether, so the sweep also runs on `visibilitychange`. This is
the caveat `presence/idle.ts` already documents, and a 24-hour reminder is
exactly the case that would expose it. It also means "overdue while chalk was
closed" needs no special path: the first sweep after load fires everything past
due.

Crossing `dueAt` sets `firedAt` and publishes a notify event. Everything after
that — rules, priority, sound, banner, the parking privacy screen's mute, DND —
is the existing pipeline at `App.tsx:1722-1759`, unchanged.

## Rendering

**Setting one.** `buildMessageMenu` (`chat/message-menu.ts:38`) gains
`{ kind: "remind" }` behind a `canRemind` opt, with its label in
`MessageMenu.tsx:31` (the `Record<MessageMenuItem["kind"], string>` is exhaustive,
so a missing label is a `tsc` error rather than a blank menu row). It belongs in
the **common** group, not the `ownerKinds` set at `MessageMenu.tsx:91` — it is
participation, not moderation. The predicate is
`canRemind: Boolean(onSetReminder)`, a capability check like `canReact`, which is
what makes it apply to own and others' messages alike.

Picking it opens `ReminderModal`: three preset buttons and a native
`<input type="datetime-local">` with `min` at now. No dependency and no new
picker component; the ephemeral-TTL `<select>` at `CreateChannelModal.tsx:174` is
the nearest precedent for the preset row. No inline `style=` — CSP is
`style-src 'self'`.

**The mark.** A row with a pending reminder carries a small clock in the left
gutter (`--chalk-msg-gutter`, `theme.css:7886`, the strip that already holds the
`⋮` marker at `MessageList.tsx:1094-1116`), with the due time in its `title`.
Under `@media (hover: none)` (`theme.css:8794`) the gutter is 0px and the `⋮` is
hidden, so on touch the mark moves inline to the head of the body span — phase
86's answer to the same problem. Rows are found by `data-message-id`
(`MessageList.tsx:1045`), as everywhere else.

**The entry.** A new `chalk-sidebar-section--reminders` block in `Sidebar.tsx`
**between the friends `</ul>` at line 674 and the parking-lot block at line 676**
— ordering in that file is plain JSX source order, no array and no config. It is
the threads entry (`Sidebar.tsx:699-723`) with a different glyph: title,
`{firedCount > 0 && <UnreadDot mention={false} />}`,
`data-testid="sidebar-reminders"`, section chrome copied from
`.chalk-sidebar-section--threads` (`theme.css:8853`).

Zuckermode re-implements the same entry points as pinned buttons, so it needs the
row too (`ZuckerList.tsx:188`/`:235` are the parking and threads ones) or the
feature disappears for anyone using that shell. And like every other sidebar
entry point, it calls `setNavOpen(false)` before dispatching, or the mobile
drawer sits on top of the panel it just opened.

**The panel.** `"reminders"` joins the `openPanel` union in **both** places in
`state/types.ts` — the state field at `:832-844` and the `open_panel` action at
`:1149` — plus the reducer's panel case. `RemindersPanel.tsx` is lazy, on
`ThreadInboxPanel.tsx`'s pattern: the shared `.chalk-modal-backdrop` /
`.chalk-modal-card` chrome, `useSwipeBack` on mobile, fired reminders first and
then pending by due time. A row shows channel, sender, when the message was sent,
when the reminder is due (`chat/reltime.ts`'s `fmtRelative`), and the preview —
falling back to the same skeleton treatment the thread inbox uses when the body
is not available. Row actions: **jump**, **snooze 1h / 24h**, **done**.

**The jump** reuses the 49-1 chain verbatim: `close_panel` →
`set_active_channel` → `setFlashMessage({channelID, messageID, seq})`, whose
crawl pages history backwards until the id appears (`App.tsx:4293-4345`), with
the scroll and highlight side at `MessageList.tsx:708-724`. `onOpenSearchResult`
(`App.tsx:4354`) is the existing caller with the closest shape.

**The badge.** Fired-and-undismissed reminders count into the tab/app badge
(`notify/badge.ts`) — it is a "needs you" count by the definition that file
already uses.

## Teardown

A tombstoned message drops its reminder, client-side, where the deletion frame is
handled. The server cannot scrub what it cannot see, so this is the only place it
can happen, and it is what stops a deleted message's cached preview living on in
the blob. Worth an assertion in a test rather than a discovery.

## Slices, if it is ever built

- **87-1 — the rules, pure.** New `web/src/chat/reminders.ts` + `reminders.test.ts`:
  the `Reminder` type, `dueAtFor(preset, now, customMs?)` with the weekend rule,
  `mergeReminders`, `canonicalReminders` (the content-compare string that breaks
  the echo loop), `fitReminders`, `pruneReminders`, `dueNow`, `pendingFor`,
  `firedCount`, `REMINDER_MAX`, `PREVIEW_MAX`. No storage, no UI.
- **87-2 — the sealed blob and its sync.** `web/src/chat/reminders-sync.ts`
  (`REMINDERS_PREFS_KEY`, the HKDF pair, `sealReminders` / `openReminders`
  version-checked and total over garbage, and a `RemindersSync` class copied from
  `crypto/pin-sync.ts` — merge in both directions, debounced upload,
  `applyRemote(undefined)` meaning seed-from-local, an undecryptable blob ignored
  rather than overwritten); `web/src/chat/reminder-store.ts` for the local record
  and the clock, localStorage-backed on `notify/rules-store.ts`'s skeleton;
  `reminders_enc?: string` beside the other sealed keys in `UserPrefs`
  (`state/types.ts:416-426`); the start/apply effect pair in `App.tsx` beside the
  rules and pin syncs (`App.tsx:800-841`). Tests for both new modules.
- **87-3 — setting one.** The menu item and its label, `ReminderModal.tsx`,
  `onSetReminder` in `App.tsx` (capturing channel, message id, `m.ts.getTime()`,
  seq and the clipped preview), the gutter mark and its mobile placement, and the
  tombstone teardown. Extends `message-menu.test.ts`.
- **87-4 — the entry and the panel.** The sidebar row, the zuckermode row, the
  `openPanel` union in both halves, `RemindersPanel.tsx` with jump / snooze /
  done. First slice a user can use end to end, so the **`CHANGELOG.md` bullet
  lands here**.
- **87-5 — firing.** The sweep, the `visibilitychange` re-evaluation, the
  overdue-on-load path, the sidebar badge and the `notify/badge.ts` count.
- **87-6 — the sound and the banner.** A new `"reminder"` `NotifyEventType` —
  the rules engine, not `MachineCategory`, because a person's message is behind
  it — across the exhaustive sites in `notify/rules.ts` (`:21`, `:33`, `:44`,
  `:105`) and a `case "reminder":` in `bannerContent` (`notify/banners.ts:50`).
  `SOUND_SPECS` (`notify/synth.ts:151`) must gain an entry or `synth.test.ts`
  goes red; see the open item below.
- **87-7 — the record.** `docs/tags.md` gains its `#reminders` phase numbers and
  paths; `docs/phase-log.md`'s index row loses *planned, not started*;
  `docs/threat-model.md` gains the line that reminders add **no** new
  server-visible metadata, so the claim is written where it will be checked.

## What each piece would reuse

| Need | Existing thing to copy or call |
|---|---|
| Seal a private blob to your own identity | `crypto/prefs-blob.ts:39,50,69,83` |
| Sync one sealed blob across devices | `crypto/pin-sync.ts`, `notify/rules-sync.ts:62` |
| Budget-fit a growing sealed set | `fitPins` `crypto/pin-backup.ts:294,314` |
| Local store behind a total normalize | `notify/rules-store.ts` |
| A singleton that owns a timer | `chat/typing-store.ts` |
| Wall-clock re-evaluation, not tick counting | `presence/idle.ts` |
| Row menu item + exhaustive label | `chat/message-menu.ts:38`, `MessageMenu.tsx:31,91` |
| Gutter marker and its mobile fallback | `MessageList.tsx:1094-1116`, `theme.css:7886,8794` |
| Badged sidebar entry | `Sidebar.tsx:699-723`, `theme.css:8853`, `UnreadDot.tsx` |
| The same entry in zuckermode | `ZuckerList.tsx:188,235` |
| A lazy modal panel with swipe-back | `ThreadInboxPanel.tsx`, `chat/use-swipe-back.ts` |
| Jump to a message not yet loaded | `App.tsx:4293-4345`, caller shape `App.tsx:4354` |
| Relative time | `chat/reltime.ts` |
| Preset picker precedent | `CreateChannelModal.tsx:174` |
| Notify event → rules → sound/banner/blink | `App.tsx:1722-1759`, `notify/bus.ts` |
| Long-press constants | `chat/press.ts` |

## Open items the design leaves

- **The sound is not designed.** `SOUND_SPECS` is a recording of a listening
  session, tuned by ear and never derived (CLAUDE.md, and the comments in
  `synth.ts` say why each number is what it is). 87-6 lands a spec marked
  provisional so the build stays green, and the phase is not finished until scuq
  runs `node tools/sound-bench.mjs`, listens, and pastes the tuned block back.
- **The ceiling is ~35–50 reminders.** Enforced visibly at the point of setting
  one. If real use pushes against it, revisit the table decision — arguing the
  leak again rather than assuming it away.
- **Nothing fires while chalk is closed.** Deliberate, and the direct cost of the
  privacy decision. The answer, if it is ever wanted, is phase 65 with its own
  opt-in.
- **Snooze presets are 1h / 24h only.** Whether snooze deserves the same four
  choices as setting one is not settled; 87-4 picks by using it and this document
  records which and why.
- **Phase 83 inheritance — actually, the absence of it.** Unlike ties, a reminder
  is not server-supplied metadata at all: it is minted, sealed and read entirely
  on the client, so a malicious server cannot fabricate one. It can withhold or
  roll back the blob (a denial, visible as reminders that do not arrive on a
  second device), but it cannot forge one, and it cannot read one.

## Verification, when built

The full chain — `go build ./... && go vet ./... && gofmt -l .`, `go test ./...`,
and from `web/`: `npx tsc --noEmit`, `node test.mjs`, `node build.mjs`. The Go
side should be untouched by this phase; if it is not, something has drifted from
this plan.

Unit cover the slices ship: the weekend rule across a Friday, Saturday and Sunday
boundary; merge convergence when one device holds nothing; done-beats-tie;
fit and prune at the budget edge; seal/open round trip and garbage → null; the
sweep against an injected clock, including overdue-on-load; teardown on
tombstone; and the extended `message-menu.test.ts`.

Then a live run through the `run-chalk` skill, two users:

1. B sets a 1h reminder on A's message and a custom one two minutes out. The
   gutter clock appears on both rows; A sees nothing at all.
2. The custom one fires: the Reminders badge lights, the sound plays, the banner
   appears, the tab count moves.
3. Open the panel and jump to a message scrolled far out of the DOM — the crawl
   backfills and the row flashes.
4. Snooze one, mark another done. Both survive a reload.
5. A second device on the same account: the set arrives without a reload, and
   dismissing on one clears on the other.
6. Wipe localStorage on one device and reconnect — the reminders come back from
   the blob, and the other device's set is **not** erased.
7. Delete a reminded message; the reminder and its cached preview go with it.
8. Phone viewport: the mark renders inline, long-press still opens the message
   menu, the panel swipes back, and the entry is present in zuckermode.
9. Park with the privacy screen on: the reminder fires silently and the tab count
   stays hidden.
10. Set reminders up to `REMINDER_MAX` and confirm the next one is refused with a
    message, not swallowed.

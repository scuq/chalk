# Phase 87 — message reminders: bringing one line back later

A way to say "not now, but don't let me lose this" about a single message,
without answering it, copying it somewhere, or leaving the channel unread as a
to-do list. Designed against v0.7.2. **IN PROGRESS: slices 87-1 to 87-5 are
built, and slices 87-6 to 87-9 are open.** The design was written on 4 August 2026 and
revised on 15 November 2026. The revision changed the presets and added a push
to a closed app. Each later slice starts with a new check of the code and a
new decision from the user.

**Status:** in progress, 87-1 to 87-5 built, design revised on 15 November 2026.
**Tag:** `#reminders` → `tools/where.sh -g reminders` (it finds this file and
the files of slices 87-1 to 87-5).

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
one of five presets or a time you pick. The presets are **this evening**,
**tomorrow morning**, **tomorrow evening**, **weekend**, and **next Monday**.
When T arrives chalk tells you, and a **Reminders** entry carries a badge until
you have dealt with it. Slice 87-4 built that entry (see *The entry*).

All times are in the local timezone of the browser:

| Preset | Due time | Not offered |
|---|---|---|
| This evening | today 18:00 | from 18:00 |
| Tomorrow morning | tomorrow 09:00 | never |
| Tomorrow evening | tomorrow 18:00 | never |
| Weekend | Saturday 09:00, and on Saturday or Sunday the Saturday after | never |
| Next Monday | the first Monday after today, 09:00 | never |
| Custom | the time you select, if it is later than now | a time in the past |

The snooze actions in the panel use the same presets.

### Decided in the design session

- **The server never learns what a reminder is about.** The reminder itself is
  a sealed record that the server cannot read. Revised on 15 November 2026: for
  a user with web push, the server also holds one small wake record for each
  pending reminder, with a due time and a random ID, so that it can send a push
  when chalk is closed. It holds no message, no channel, no sender, and no
  preview. A user with no push subscription leaves no due time in the database.
  The argument for a record this small is in *Rejected: firing on the server*,
  and the record is in *The wake record on the server*.

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
  it is already the weekend. This rule did not change in the revision. The alternative — Friday 18:00, "when the week is
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
(`scalarFromX25519` at :41, `blobKey` at :52, `sealJSON` at :71, `openJSON` at :85), with its own
salt/info pair `chalk-reminders-salt-v1` / `chalk-reminders-v1` so the key is
independent of every other use of that scalar.

This is a rail three features already run on: the notification rules (50-6,
`notify/rules-sync.ts`), the per-peer audio list (66-3,
`voice/peer-audio-sync.ts`) and the identity pins (84-1, `crypto/pin-backup.ts`).
Every device that can read messages derives the same key, so cross-device sync
and the `prefs_changed` fan-out come for free.

What follows from it:

- **Slices 87-1 to 87-6 have no migration, no wire frames, and no server code.**
  Phase 86's reserved `migrations/0051_message_ties.sql` stays reserved. In
  those slices phase 87 does not take a migration number because it does not have
  a table, and `go build` output is byte-identical before and after them. Slices
  87-7 and 87-8 add migration 0065, one frame, and a sweep loop (see *The wake
  record on the server*).
- **The prefs key change is opaque to the server**, indistinguishable from a
  notification-rule edit. The blob does not tell the server which message a
  reminder points at, or when it is due.
- **The open client fires reminders.** An overdue reminder is waiting the moment
  you open chalk. For a closed app, the push of slices 87-7 and 87-8 fires it.

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
privacy. `sealJSONForChannel` in `crypto/channel-crypto.ts` is not the primitive this
phase wants.

### Rejected: firing on the server, and what changed

The first design rejected a janitor loop past a `due_at` column that pushes a
frame. chalkd already has six of these (`EphemeralJanitorLoop`,
`runGovernanceSweeper`, the session and invite janitors), so it would be cheap,
and it would work on a device that was asleep.

It needs the due time in plaintext. That is the leak that the whole design
exists to avoid, and it is a *worse* one than the table above, because a due time
is a statement about the future: "X intends to deal with this on Monday at 09:00"
is scheduling information about a person, not about a message. The first design
said that a reminder for a closed client is a phase-65 (web push) conversation
with its own opt-in and its own `docs/threat-model.md` line.

That conversation took place on 15 November 2026. Two facts changed the result:

- A reminder must fire when chalk is closed. Only web push (phase 65) can reach
  a closed app, and only the server can send a push.
- The trust model of 9 August 2026 trusts `chalkd` and does not trust the host
  that it runs on. The first design assumed a server that must learn nothing.

The old argument stays as the reason that the record is this small. The server
gets a due time with a random ID. It does not get the message, the channel, or
the text. The table `message_reminders` and `sealJSONForChannel` stay rejected.

### The wake record on the server

The sealed prefs blob `reminders_enc` stays the only place that holds a
reminder. The server gets one more record for each pending reminder, a wake
record (a due time with a random ID). Slices 87-7 and 87-8 build it.

- The record holds the user ID, the reminder ID, and the due time.
- The reminder ID is a random UUID from the client. It names no message and no
  channel.
- The client sends the full set of wake records in one frame, at each welcome
  and after each change.
- The server replaces the stored set with that frame. This makes the frame
  idempotent (safe to send twice).
- The server stores the set only if the user has one or more push
  subscriptions. If not, it deletes the set.

The last rule makes the push opt-in of phase 65 the opt-in for this record. A
user without push on any device leaves no due time in the database. On an
instance where the operator has push off (`push_enabled` is false in
`/api/auth/config`), the client sends no frame.

### The push

A sweep loop in `chalkd` finds the wake records that are due.
`EphemeralJanitorLoop` in `internal/store/channel_purge.go` is the model for the
loop. For each due record the server does these steps:

1. It deletes the record.
2. If the user has a device in state `online`, it stops. The open client fires
   the reminder.
3. If not, it sends one push with `kind: "reminder"` and the reminder ID to each
   subscription of the user.

The service worker has no key, so the notification cannot show the message
text. It shows one constant line, for example "Reminder: a message is due". A
click opens chalk. The page finds the reminder by its ID in the sealed set and
starts the jump to the message. The jump is the existing `setFlashMessage` path
in `web/src/components/App.tsx`.

### What the server and the push service learn

Slice 87-9 repeats these facts in `docs/threat-model.md`.

- The database holds, for a user with push on, the due time of each pending
  reminder and the count.
- The database does not hold the message, the channel, the sender, or the
  preview.
- The push service sees one more push at the due time. A push at exactly 09:00
  or 18:00 can look like a reminder to it.
- A stolen database yields no sent message through this record, so the claim
  about stored state holds.

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
(`internal/proto/frames.go`, `web/src/proto.ts`). `seq` rides along for
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

Both directions go through `mergeReminders`, on the reasoning in the header
comment of `crypto/pin-sync.ts`: a device whose localStorage was just cleared holds nothing, and
last-write-wins would have it upload that emptiness over the set every other
device depends on. `RemindersSync` (87-2) does this. A device with an empty
local set never deletes anything on the server. The rules sync is different: it
overwrites.

The rule is a total order over any two records with the same `id`:

- higher `updatedAt` wins;
- on a tie, the record with `doneAt` set wins.

Done being sticky is what stops a stale device resurrecting a reminder you
dismissed — the failure mode that makes people stop trusting a to-do list.

### The ceiling, stated plainly

`prefsMaxBytes = 8 * 1024` (`internal/server/ws.go:3056`) caps a prefs patch, and
pin-backup's `BLOB_BUDGET_BYTES = 7900` is the working budget one blob gets. The
budget applies to the base64 of the nonce, the ciphertext, and the tag
(`sealedLength` in `pin-backup.ts`). It does not apply to the packed bytes. So
the plaintext room is 5897 bytes. A packed reminder with no preview is up to
about 205 bytes, so about 28 fit.

`REMINDER_MAX = 25`. Slice 87-1 sets it, and a test asserts that 25 records of
the largest shape always fit with no preview. The cap counts at the point where
a reminder is *set*, with a plain message ("25 reminders is the limit — clear a
few"). A limit must never be hit silently.

`fitReminders` is the safety net behind the cap. It is modelled on `fitPins`
(`pin-backup.ts`). It sorts the set into the keep order:

1. Fired and not done, the latest `firedAt` first.
2. Pending, the earliest due time first.
3. Done, the latest `doneAt` first.

It then deletes previews one at a time from the end of that order until the set
fits. If no preview is left and the set is still too large, it drops records
from the end of that order. The size test uses the UTF-8 byte length, because a
preview can hold non-ASCII text. `previewsStripped` in the result is a count.

`pruneReminders` deletes each record with a `doneAt` older than seven days
(`DONE_KEEP_MS`). In practice this keeps anyone from reaching the cap.

The known limit of the prune rule: a pruned record leaves no tombstone. A device
that was offline for more than seven days can hold a stale pending copy of a
pruned record. That copy returns at the next merge, fires as overdue, and you
mark it done again.

If reminders turn out to be something people keep hundreds of, that is the signal
to revisit the table decision above — with the leak argued again, not assumed
away.

## Firing

**An effect in `App.tsx` with two pure helpers.** The reducer is pure and cannot
hold a timer, and driving expiry from a dispatch would rebuild `AppState` on
every tick forever, so the timer lives in an effect. Slice 87-5 built it this
way and not as a module singleton on the shape of `chat/typing-store.ts`. The
helpers `fireDue(list, nowMs)` and `nextSweepDelay(list, nowMs)` are in
`chat/reminders.ts`. Both take the clock as a parameter, which makes them
testable without fake timers. The effect sets one timer for the earliest
pending reminder, at most `SWEEP_MAX_MS` (60 seconds), and sets no timer while
nothing is pending.

**Deadlines are recomputed from `Date.now()` deltas, never by counting ticks.**
A hidden tab's timers are clamped to about one a minute and a slept or frozen one
stops firing altogether, so the sweep also runs on `visibilitychange`. This is
the caveat `presence/idle.ts` already documents, and a 24-hour reminder is
exactly the case that would expose it. It also means "overdue while chalk was
closed" needs no special path: the first sweep after load fires everything past
due.

Crossing `dueAt` sets `firedAt`. Slice 87-5 does only this. The notify event
belongs to slice 87-6. Everything after the event — rules, priority, sound, banner, the parking privacy screen's mute, DND —
is the existing notify pipeline in `App.tsx` (the `notify/bus.ts` events), unchanged.

## Rendering

**Setting one.** `buildMessageMenu` (`chat/message-menu.ts`) has
`{ kind: "remind" }` behind a `canRemind` opt, with the label "remind me..." by
default. The item carries its own `label`, as the `delete` item does, and
`MessageMenu.tsx` shows it. The `remind` entry in `LABELS` stays because the
`Record<MessageMenuItem["kind"], string>` is exhaustive. A message with a
pending reminder shows "change reminder..." (`remindLabel` in the menu opts). The item sits
after "copy text" and before "edit". It belongs in
the **common** group, not the `ownerKinds` set in `MessageMenu.tsx` — it is
participation, not moderation. The predicate in `MessageList.tsx` is
`canRemind: Boolean(onRemindMessage)`, a capability check like `canReact`, which is
what makes it apply to own and others' messages alike.

Picking it opens `ReminderModal`. If the message has a pending reminder, the
modal shows "set for <local date and time>" and a "remove" button, and a new
time replaces the old reminder. The modal body mounts new at each open. Without a pending reminder, the modal has one button for each preset that is
offered at that time, each with its due time, and a native `<input type="datetime-local">` with `min` at
now. No dependency and no new picker component; the ephemeral-TTL `<select>`
(`ttlSecs`) in `CreateChannelModal.tsx` is the nearest precedent for the preset
row. No inline `style=` — CSP is
`style-src 'self'`.

**The mark.** A row with a pending reminder carries a small clock. The clock is
`ReminderIcon` from the shared icon family (`icons.tsx`), in the bright text
color of the theme. An emoji keeps its own colors and does not match a theme.
The clock is
one element, the first child of the body span in `MessageList.tsx`, with the due
time in its `title`. With a pointer that can hover, it sits in the left gutter
(`--chalk-msg-gutter` in `theme.css`, the strip that already holds the `⋮`
marker), at the place of the `⋮`. The mark is hidden while the row is hovered or
its menu is open, so the two do not overlap. That rule is inside
`@media (hover: hover)`, because a touch browser can keep `:hover` after a tap.
Under `@media (hover: none)` in `theme.css` the gutter is 0px and the `⋮` is
hidden, so the mark is inline before the text — phase
86's answer to the same problem. Only a pending reminder (not fired, not done)
shows the mark, from `pendingFor`. The mark has `data-testid="message-reminder-<id>"`.

**The entry.** A new `chalk-sidebar-section--reminders` block in `Sidebar.tsx`,
above the parking-lot block and below the friends list — ordering in that file
is plain JSX source order, no array and no config. It is its own class family
(`chalk-sidebar-reminders*`), copied from the threads entry
(`.chalk-sidebar-section--threads` in `theme.css`) with the `ReminderIcon` glyph.
It holds the title "reminders", the count of reminders that are not done in
parentheses, and `{remindersFired > 0 && <UnreadDot mention={false} />}`. It has
`data-testid="sidebar-reminders"`. It always shows on a desktop, also when the
count is 0.

`ZuckerList` mounts only on the phone. The phone list has no parking row after
137-10, because the parking lot became a head button. So the phone entry is a sixth head button of `ZuckerList.tsx`, between threads and
filter (`data-testid="zucker-reminders"`), with a dot when a reminder has fired.
It shows only when one or more reminders are not done, to keep the head short.
On a phone with no reminder there is no entry. None is necessary, because the
list would be empty.

**The panel.** `"reminders"` joins the `openPanel` union in **both** places in
`state/types.ts` — the `openPanel` state field and the `open_panel` action —
plus the reducer's panel case. The reducer branch must exist, because with no
branch the fallthrough opens the profile panel. `RemindersPanel.tsx` is lazy, on
`ThreadInboxPanel.tsx`'s pattern: the shared `.chalk-modal-backdrop` /
`.chalk-modal-card` chrome, and `useSwipeBack` on mobile. It reuses the thread
inbox classes `chalk-threadinbox-panel`, `-header`, `-title`, `-actions`,
`-empty`, and `-empty-hint`, and has its own `chalk-reminders-*` classes for the
rows. It lists each reminder that is not done: the fired reminders first, the
latest fired first, then the pending reminders, the earliest due time first
(`panelRows`, the order that `fitReminders` keeps).

A row shows the channel name, how long ago the message was sent
(`fmtRelative`), the due time, and the preview. A pending reminder shows the
time until it is due (`fmtUntil` in `chat/reltime.ts`). A fired reminder shows
"due" and how long ago. If the reminder has no preview, the row shows
"(no preview)". The design had a sender name and a skeleton here. The record has
no sender, so the row has neither. The panel reads the clock every 30 seconds,
so the relative times stay correct while it is open.

Row actions are **jump**, **snooze**, and **done**. The row is the jump button.
Snooze opens the presets of the table above, each one that is offered at that
time, and the native date-time input with a "set" button, under the row.
`snoozeReminder` sets the new due time and clears `firedAt`, so a fired
reminder is pending again. Escape closes the snooze choices first, and the panel
on the second press. Done uses `markDone`. Both functions raise `updatedAt` with
`bump`, so the change wins the merge on the other devices.

If the channel of a reminder is not in `state.channels` (the user left it, or it
is gone), the row shows "channel not available", and the jump button is
disabled. Snooze and done still work.

**The jump** reuses the 49-1 chain: `close_panel`, then `set_active_channel`
if the channel is not the active one, then
`setFlashMessage({channelID, messageID, seq})`. The crawl pages history
backwards until the id appears, 20 pages at most (`App.tsx:5632-5666`), with the
scroll and highlight side at `MessageList.tsx:1017-1033`. `onJumpReminder` in
`App.tsx` does this, and `onOpenSearchResult` is the caller with the closest
shape. If the reminder had fired, the jump also marks it done. A pending
reminder stays.

**The badge.** Fired-and-undismissed reminders count into the tab/app badge
(`notify/badge.ts`) — it is a "needs you" count by the definition that file
already uses.

## Teardown

A deleted message drops its reminder on the client. The server cannot scrub what
it cannot see, so this is the only place it can happen. It stops the cached
preview of a deleted message from living on in the blob.

The merge of the sync never deletes a record, so a reminder cannot leave the
set. `retireForMessage` marks the reminder done (`doneAt`) and raises
`updatedAt`. The prune after `DONE_KEEP_MS` removes the record later.

An effect in `App.tsx` does the work. It looks at the loaded messages of each
reminder. If the message is deleted, the effect runs `retireForMessage` with
`dropPreview` true. This also deletes the preview from a record that is already
done. The effect does not hook the `message_deleted` frame.

The known limit: a reminder for a message in a channel whose history is not
loaded keeps its preview until that channel loads.

## Slices

The `CHANGELOG.md` bullet lands in 87-4, the first slice a user can use end to
end.

- **87-1 — the rules, pure. BUILT.** New `web/src/chat/reminders.ts` and
  `reminders.test.ts`. No storage, no timer, no UI, no server code. The file
  exports `Reminder`, `ReminderPreset`, `REMINDER_PRESETS`, `REMINDER_MAX`,
  `PREVIEW_MAX`, `MORNING_HOUR`, `EVENING_HOUR`, `DONE_KEEP_MS`,
  `REMINDERS_VERSION`, `dueAtFor`, `clipPreview`, `mergeReminders`,
  `PackedReminder`, `packReminder`, `unpackReminders`, `canonicalReminders`,
  `ReminderFit`, `fitReminders`, `pruneReminders`, `dueNow`, `pendingFor`, and
  `firedCount`. One change to an existing file: `sealedLength` in
  `crypto/pin-backup.ts` gained the `export` keyword, so there is no second copy
  of the size formula.
- **87-2 — the sealed blob and its sync. BUILT.** The files are
  `web/src/chat/reminders-sync.ts`, `web/src/chat/reminder-store.ts`, and a test
  file for each. No server code. The sync file exports `REMINDERS_PREFS_KEY`,
  `UPLOAD_DEBOUNCE_MS` (3 s), `RETRY_MS` (15 s), `remindersAesKey`,
  `sealReminders`, `openReminders`, `RemindersSyncTransport`, `RemindersStorage`,
  and `RemindersSync`. The store file exports `reminderStorageKey`,
  `loadReminders`, `saveReminders`, `clearReminders`, and `subscribeReminders`.
  `reminders_enc?: string` is in `UserPrefs` (`state/types.ts`), and a start
  effect and an apply effect in `App.tsx` follow the pin sync. `handleLogout`
  calls `clearReminders`. The decisions:
  - `openReminders` checks the version and the shape. Then `unpackReminders`
    skips a bad row and keeps the rest. The pin backup rejects the whole blob for
    one bad row. A reminder is cheaper to lose than a pin.
  - Two guards stop an echo loop. `lastJSON` holds the canonical content that the
    server holds. `lastBlob` holds the exact ciphertext that the sync last saw or
    sent.
  - An undecryptable blob is ignored and nothing is sent in answer. A later local
    change publishes over it, as in the pin sync.
  - `RemindersSyncTransport.send` returns a boolean. If the socket is closed, the
    send reports false, `lastJSON` goes back to its old value, and a retry runs
    after `RETRY_MS`. The pin sync and the rules sync lose such a send until the
    content changes.
  - The `App.tsx` effect stops the sync and clears its ref in the cleanup. An
    account change in one page load then starts a new sync with the new identity.
    The three older syncs keep their first instance.
  - The local store key is `chalk.reminders.v1.<userID>`. No other localStorage
    store in chalk is per user. The blob is sealed with the identity of one
    account. A store that two accounts on one browser share would upload the
    reminders of the first account into the prefs of the second.
  - The local store holds previews in plaintext, so `handleLogout` calls
    `clearReminders`. The sealed blob restores the set at the next login. A change
    that was not yet uploaded at logout is lost.
  - The store keeps an in-memory copy for each user. If `setItem` fails (private
    mode or quota), the set stays for the page load and the listeners still run.
    A `storage` event from another tab drops the copy, so the next load reads
    localStorage again.
  - `push` prunes the done records older than `DONE_KEEP_MS` from the local set
    and from the blob.
  - `fitReminders` can delete previews or drop records before the seal. A dropped
    record stays on the device, and a console warning gives the count.
- **87-3 — setting one. BUILT.** The files are `web/src/components/ReminderModal.tsx`,
  and changes in `web/src/chat/reminders.ts`, `web/src/chat/message-menu.ts`,
  `web/src/components/MessageMenu.tsx`, `web/src/components/MessageList.tsx`,
  `web/src/components/App.tsx`, `web/src/theme.css`, and the two test files.
  No server code. The decisions:
  - The menu label is "remind me...". The item sits after "copy text" and before
    "edit". It shows on own and on other users' messages, in the channel feed
    only. The thread panel does not pass `onRemindMessage` (see the open items).
  - The voice-channel scratchpad does not offer the item, because its messages
    are deleted when the call ends.
  - `onSetReminder` in `App.tsx` captures the channel, the message ID,
    `m.ts.getTime()`, `seq`, and the clipped preview. It calls `addReminder`.
  - A second reminder on one message replaces the first. `addReminder` retires
    each reminder of that message that is not done, and then adds the new one.
  - `addReminder` returns null at `REMINDER_MAX` reminders that are not done.
    Done records do not count. `App.tsx` then shows "25 reminders is the limit —
    clear a few." in the modal, and the modal stays open.
  - `retireForMessage` takes a reminder away by marking it done, because the
    merge never deletes a record. `bump` gives `max(now, updatedAt + 1)`, so the
    change wins the merge also when the clock of this device runs behind.
  - The modal reads the clock when it opens and again at the click. A preset
    that stopped being offered while the modal was open (this evening, at 18:00)
    is not set with a wrong time.
  - `toLocalInput` and `fromLocalInput` convert between epoch milliseconds and
    the `datetime-local` value, in the local timezone of the browser.
  - A message with a pending reminder shows "change reminder..." in the menu.
    The modal then shows the current due time and a "remove" button. A new time
    replaces the old reminder. "remove" calls `retireForMessage` with
    `dropPreview` false, so the reminder is marked done and the preview stays,
    because the message still exists.
  - `ReminderModal` returns null when closed. Otherwise it renders
    `ReminderModalBody`, which mounts new at each open, so its state starts new.
    The first version cleared its state in an effect after the open. The demo
    found that this effect ran late and deleted input typed before it ran.
  - The clock mark is `ReminderIcon`, in the bright text color of the theme.
    An emoji keeps its own colors and does not match a theme.
  - The clock mark and the teardown are as in *Rendering* and *Teardown*.
    `pendingReminders` in `App.tsx` is a `useMemo` over the reminder set and the
    active channel.
  - The new exports of `reminders.ts` are `activeCount`, `PRESET_LABELS`,
    `retireForMessage`, `NewReminder`, `addReminder`, `toLocalInput`, and
    `fromLocalInput`. The tests extend `message-menu.test.ts` and
    `reminders.test.ts`.
  - The browser check is partly done. See *Verification, when built*.
- **87-4 — the entry and the panel. BUILT.** The first slice that a user can use
  end to end, so the `CHANGELOG.md` entry lands here. The files are
  `web/src/components/RemindersPanel.tsx`, `web/src/chat/reltime.test.ts`, and
  changes in `web/src/chat/reminders.ts`, `web/src/chat/reltime.ts`,
  `web/src/components/App.tsx`, `web/src/components/Sidebar.tsx`,
  `web/src/components/ZuckerList.tsx`, `web/src/state/types.ts`,
  `web/src/state/reducer.ts`, `web/src/theme.css`, and the tests. No server
  code. The decisions:
  - The panel lists each reminder that is not done, in the order of `panelRows`.
    A row shows the channel name, how long ago the message was sent, the due
    time, and the preview. A pending reminder shows `fmtUntil`. A fired reminder
    shows "due" and how long ago.
  - `fmtUntil` gives "now", "in under 1m", "in Nm", "in Nh", then a lowercase
    weekday with a 24-hour time inside six days, then the month, the day, and
    the time. `fmtRelative` formats only past times, which is why the function
    exists.
  - The jump closes the panel, switches the channel, and sets `flashMessage`. If
    the reminder had fired, the jump also marks it done. A pending reminder
    stays.
  - A reminder whose channel is not in `state.channels` shows "channel not
    available". Its jump button is disabled, and `onJumpReminder` returns.
    Snooze and done still work.
  - Snooze sets the new due time and clears `firedAt`. Done sets `doneAt`. Both
    use `bump` for `updatedAt`.
  - The desktop entry is a "reminders" row in the sidebar, between the friends
    list and the parking lot. It shows the count of reminders that are not done,
    and the unread dot when one or more have fired. It always shows.
  - The phone entry is a sixth button in the head of the conversation list,
    between threads and filter. It shows a dot when a reminder has fired. It
    shows only when one or more reminders are not done.
  - The panel reuses the chrome classes of the thread inbox and has its own
    `chalk-reminders-*` classes for the rows.
  - Slice 87-5 sets `firedAt`, so the dot and the style of a fired row show
    from that slice.
  - The browser check is partly done. See *Verification, when built*.
- **87-5 — firing. BUILT.** The files are `web/src/chat/reminders.ts`,
  `web/src/notify/badge.ts`, `web/src/components/App.tsx`, and the tests of the
  first two.
  - `fireDue` sets `firedAt` on each pending reminder that is due, and returns
    null if none is due. `nextSweepDelay` returns the time to the earliest
    pending due time, at most `SWEEP_MAX_MS`.
  - The sweep is an effect in `App.tsx` after `openReminders`. It runs when the
    set changes, when the timer of the earliest pending reminder ends, and when
    the tab becomes visible. The first run after load fires each reminder that
    became due while chalk was closed.
  - Firing does not change `updatedAt`. A snooze or a done mark from another
    device therefore wins the merge over a fire that did not see it. `winner`
    got two more rules for an equal `updatedAt`: after done wins, fired wins
    over pending, and then the earlier `firedAt` wins. Two devices that fire
    one reminder converge on one record and do not upload in turn.
  - The sweep waits for `remindersSettled`. The state is true after the first
    merge with the server blob ends. It is also true 10 seconds after the sync
    starts if no blob arrives. It resets when the account changes.
  - `badgeCount` has a new input, `firedReminderCount`, and the tab title and
    the app badge include the fired reminders.
  - A user sees a dot on the reminders entry (the sidebar row and the phone
    head button). The row in the list shows as due and sorts first. The clock
    mark leaves the message row.
  - The notify event, the sound, and the banner belong to slice 87-6. Nothing
    fires while chalk is closed. Slices 87-7 and 87-8 build that.
  - Known limit: on a slow connection, the sweep can fire a reminder before the
    remote merge ends, after the 10-second fallback. The merge then corrects
    the record.
  - The browser check is not done. See *Verification, when built*.
- **87-6 — the sound and the banner.** A new `"reminder"` `NotifyEventType` —
  the rules engine, not `MachineCategory`, because a person's message is behind
  it — across the exhaustive sites in `notify/rules.ts` (`NotifyEventType`,
  `NOTIFY_EVENT_TYPES`, `EVENT_TYPE_LABELS`, and the defaults) and a
  `case "reminder":` in `bannerContent` (`notify/banners.ts`). `CUE_FOR`
  (`notify/themes.ts`) must gain a row or `themes.test.ts` goes red; see the
  open item below.
- **87-7 — the wake record.** Migration 0065, the store methods, the wake frame,
  and the reconcile at welcome. Server code.
- **87-8 — the push.** The sweep loop, the `reminder` push kind, the service
  worker text, and the click-to-jump path. Server code.
- **87-9 — the record.** `docs/tags.md`, `docs/phase-log.md`,
  `docs/threat-model.md`, and `docs/wire-protocol.md`. The threat model gets the
  facts of *What the server and the push service learn*, so the claim is written
  where it will be checked. Slice 87-1 already sets the `#reminders` line in
  `docs/tags.md` and the row in `docs/phase-log.md`.

Slices 87-1 to 87-6 give a reminder that works while chalk is open. Slices 87-7
and 87-8 add the closed app.

## What each piece would reuse

| Need | Existing thing to copy or call |
|---|---|
| Seal a private blob to your own identity | `crypto/prefs-blob.ts:41,52,71,85` |
| Sync one sealed blob across devices | `crypto/pin-sync.ts`, `RulesSync` in `notify/rules-sync.ts` |
| Budget-fit a growing sealed set | `fitPins` and `sealedLength` in `crypto/pin-backup.ts` |
| Local store behind a total normalize | `notify/rules-store.ts` |
| A singleton that owns a timer | `chat/typing-store.ts` |
| Wall-clock re-evaluation, not tick counting | `presence/idle.ts` |
| Row menu item + exhaustive label | `chat/message-menu.ts:43`, `MessageMenu.tsx:33,94` |
| Gutter marker and its mobile fallback | the `⋮` marker in `MessageList.tsx`, `--chalk-msg-gutter` in `theme.css` |
| Badged sidebar entry | the threads entry in `Sidebar.tsx`, `.chalk-sidebar-section--threads` in `theme.css`, `UnreadDot.tsx` |
| The same entry on the phone | the parking and threads buttons in `ZuckerList.tsx` |
| A lazy modal panel with swipe-back | `ThreadInboxPanel.tsx`, `chat/use-swipe-back.ts` |
| Jump to a message not yet loaded | `App.tsx:5632-5666`, caller shape `App.tsx:5675` |
| Relative time | `chat/reltime.ts` |
| Preset picker precedent | the `ttlSecs` select in `CreateChannelModal.tsx` |
| Notify event → rules → sound/banner/blink | the notify pipeline in `App.tsx`, `notify/bus.ts` |
| Long-press constants | `chat/press.ts` |

## Open items the design leaves

- **The sound is not designed.** Since phase 102 a sound is a recorded cue
  per theme (`web/assets/sounds/<theme>/`), authored by scuq in a DAW. 87-6
  maps `reminder` to an existing cue (`10_new_message` is the obvious
  provisional choice) so the build stays green; a reminder cue of its own means
  a new file in each of the three themes and a `ThemeCue` entry, and the phase
  is not finished until those exist.
- **The ceiling is 25 reminders.** About 28 records with no preview fit the blob.
  The cap is enforced visibly at the point of setting one, with the message
  "25 reminders is the limit — clear a few". If real use pushes against it,
  revisit the table decision — arguing the leak again rather than assuming it
  away.
- **Two limits remain for a closed app.** Nothing fires for a user without push,
  because there is no wake record and no push. The notification of a closed app
  cannot show the message text, because the service worker has no key.
- **Reminders on thread replies are open.** The thread panel has no "remind
  me..." item. The `Reminder` record holds no thread ID, and the jump of slice
  87-4 needs one to open a thread. A later slice must add a thread ID to the
  record, or the panel stays without the item.
- **The teardown has a limit.** A reminder for a message in a channel whose
  history is not loaded keeps its preview until that channel loads (see
  *Teardown*).
- **Snooze uses the same presets as setting one.** This item is settled. The
  snooze actions use the table in *What it is*.
- **Phase 83 inheritance — actually, the absence of it.** Unlike ties, a reminder
  is not server-supplied metadata at all: it is minted, sealed and read entirely
  on the client, so a malicious server cannot fabricate one. It can withhold or
  roll back the blob (a denial, visible as reminders that do not arrive on a
  second device), but it cannot forge one, and it cannot read one.

## Verification, when built

The full chain — `go build ./... && go vet ./... && gofmt -l .`, `go test ./...`,
and from `web/`: `npx tsc --noEmit`, `node test.mjs`, `node build.mjs`. In slices
87-1 to 87-6 the Go side must be untouched. If it is not, something has drifted
from this plan. Slices 87-7 and 87-8 change the Go side: they add migration 0065,
one frame, and the sweep loop, with their own Go tests.

Unit cover the slices ship: the presets across a Friday, Saturday and Sunday
boundary; merge convergence when one device holds nothing; done-beats-tie;
fit and prune at the budget edge; seal/open round trip and garbage → null; the
sweep against an injected clock, including overdue-on-load; teardown on
tombstone; and the extended `message-menu.test.ts`.

Then a live run through the `run-chalk` skill, two users:

1. B sets a "tomorrow morning" reminder on A's message and a custom one two
   minutes out. The gutter clock appears on both rows; A sees nothing at all.
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
   menu, the panel swipes back, and the head button of the conversation list is
   present while a reminder is not done.
9. Park with the privacy screen on: the reminder fires silently and the tab count
   stays hidden.
10. Set reminders up to `REMINDER_MAX` and confirm the next one is refused with a
    message, not swallowed.

The browser check of 87-3 is done on a desktop viewport. A headed run on 15
November 2026 through the `run-chalk` probe passed these steps:

- The menu item on the message of another user.
- The five presets, each with its due time.
- The mark in the gutter, clear of the timestamp.
- The mark hidden on row hover.
- A custom time on an own message.
- "change reminder..." with "remove".
- Both reminders present after a reload.

Three checks stay open:

- On a phone viewport, check the inline mark and the long-press menu.
- Set `REMINDER_MAX` reminders, and check the cap message in the modal.
- Delete a reminded message, and check that the mark goes.

The browser check of 87-4 is done on a desktop viewport. A run on 15 November
2026 through the `run-chalk` probe passed these steps:

- The sidebar entry shows the count.
- The panel lists both reminders.
- Snooze shows the presets and moves the due time.
- Jump closes the panel and flashes the message.
- Done removes the row and the mark, and lowers the count.

Three checks stay open:

- On a phone viewport, check the head button and the panel with swipe back.
- Jump to a message that is not loaded, and check the crawl.
- Check a reminder whose channel is gone.

After slices 87-7 and 87-8, add these steps for the closed app:

11. A user with a push subscription sets a reminder and closes chalk on a phone.
    At the due time the phone shows the notification with the constant line.
12. A click on that notification opens chalk and jumps to the message.
13. A user with no push subscription sets a reminder. The database holds no wake
    record for that user.

The browser check of 87-5 passed on a desktop viewport on 15 November 2026:

- A reminder became due while chalk was open. The entry got the dot, the row
  showed as due in the list, the clock mark left the message row, and the tab
  title showed the count.
- A reminder became due while the page was closed. It fired at the next load,
  and the tab title showed two.
- "Show message" on a fired row marked it done, and the count went down.
- A snooze of a fired row made it pending again. The dot and the tab count went
  away, and the clock mark came back.

These checks of 87-5 are open:

- The app badge of an installed chalk.
- On a phone viewport, the dot on the head button.

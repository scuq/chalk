# Phase 92 — the hover card

**Status:** 92-1, 92-2, 92-4, 92-5 and 92-6 shipped. 92-3 (device type) is
**designed and deliberately not built** — see
[The device line](#the-device-line-92-3-not-built).

**Tag:** `#roster` → `tools/where.sh -g roster`, `#presence` for the last-seen
plumbing.

The phase started as one tooltip on one surface (92-1/92-2, below) and was
extended to the message feed's sender names, with a display-name line on both,
in 92-4 through 92-6 — [The second surface](#the-second-surface-92-4-92-6).

## The problem

Rest the pointer on a friend in the roster and the browser eventually shows a
native `title` tooltip: `dana — online — start chat`. That was the whole of it.

Two things were wrong with that. The first is that the roster shows a coloured
dot and a name, and the dot answers "is she there?" but never "since when?" —
so an `away` dot is indistinguishable from an `away` dot from four hours ago,
which is the difference between "ping her now" and "leave it until tomorrow".
The second is that the answer was already on the wire and being thrown away:
the presence push has carried `at` — unix-millis of the most recent activity
across the user's devices — since phase 06, and the client parsed the frame,
read `state`, and dropped `at` on the floor.

## The design

A hover card on the desktop roster row, opened by a deliberate rest of the
pointer, carrying what the `title` carried plus the time.

- **Name, state, last seen, and the action hint.** The name is tinted with the
  friend's nick hue, the same colour the message feed and the roster menu use.
  The hint (`start chat`) only appears when no DM with that friend exists yet,
  which is exactly when the old `title` showed it.
- **Last seen is omitted when it would be noise.** An `online` friend gets no
  time line — the dot already says "now", and "last seen just now" underneath a
  green dot is a line that never varies. Nor is it shown when there is no
  usable timestamp; see below for when that is.
- **It replaces the `title`, it does not sit beside it.** Leaving both would
  have the browser's own tooltip fade in about half a second after the card,
  over the top of it, saying a subset of the same thing.
- **Mouse and keyboard, not touch.** The card opens on a 500 ms mouse rest and
  on `:focus-visible`, so tabbing the roster shows it. Touch never opens it:
  the long press on a roster row is already the nick menu (9.7f), and the
  mobile roster is `ZuckerList`, which is a different component entirely.

### The server does not keep a last-seen time

This is the thing to know before touching the feature, and it was found by
running it rather than by reading it (`probes/ui.mjs`, 92-1).

`ClearDevicePresence` **deletes** the `device_presence` row when a socket
closes. So a user who has just gone offline aggregates over zero rows:
`AggregateUserState` returns `StateOffline` and a zero `time.Time`, and
`at.UnixMilli()` on a zero `time.Time` is `-6795364578871` — a large negative
number, not a zero, which is why every guard here tests `> 0` rather than
truthiness. There is nowhere in the schema that remembers when someone was
last around; presence is live state and only live state.

What makes the line work anyway is that the client watched it happen. The
reducer stores a timestamp only when the push carries a usable one, so the
last heartbeat seen while the friend was online survives their disconnect and
is what the card ages. Two consequences, both deliberate:

- **A reload forgets.** Open chalk fresh and a friend who has been offline
  since yesterday shows state only — the client never saw them online, and the
  server has nothing to tell it. Same after a reconnect, which clears the map.
- **It is heartbeat-grained.** `last_seen` advances on the heartbeat, which is
  `TTL/3` — 200 s on desktop. A friend who vanishes can read as "last seen 3m
  ago" the moment they go, and `fmtRelative` rounds to minutes regardless.

Making this durable is a server change, and a different decision from this
phase: it means persisting a per-user "last online" that outlives the session,
which is a standing record of everyone's habits rather than a live signal that
evaporates. If it is ever wanted it belongs next to the 92-3 opt-in below, on
the same switch.

### Why a separate `lastSeen` map

`PresenceMap` is `Record<string, string>` and five call sites index it and
hand the result straight to `presenceClass` / `presenceLabel` — including
`ZuckerList` and `buildFriendList`, neither of which has any use for a
timestamp. Widening the value to `{state, at}` would have touched all of them
and their tests to deliver a field one component reads.

So the timestamp lives in a sibling `lastSeen: Record<string, number>`, keyed
identically. The two maps are written in exactly three places — `presence_set`,
`presence_clear`, `presence_reset` — which is what keeps them from drifting;
any future presence action must touch both, and `reducer-presence.test.ts`
asserts each of the three does.

### The device line (92-3, not built)

The obvious fourth line is *which* device — `online — phone`. The data exists:
`device_presence.device_type` is one of `phone | tablet | desktop |
browser-unknown`, classified server-side from the client's hello claim by
`classifyDeviceType` (`internal/server/ws.go`).

It is not built, and not merely for effort. `AggregateUserState` deliberately
collapses every device a user has to one state and one timestamp, and that
collapse is the privacy boundary: a friend learns *that* you are around, never
*how*. "Online on phone" is a context signal — out and about versus at the desk
— and chalk does not otherwise hand friends ambient metadata about each other.
The multi-device case makes it worse rather than better: someone online on a
desktop and a phone forces either a longer disclosure (`desktop, phone`) or a
precedence rule that quietly picks one and is therefore sometimes a lie.

If it is ever built it should be **opt-in per user**, defaulting off, with a
friend who has not opted in showing a card with no device line and no
placeholder. It would also need to be honest in the doc that this is
server-asserted metadata: chalkd sees the hello claim and could substitute it,
the same way it could lie about presence. That is a different bar from the rest
of the card, all of which is either client-local or already disclosed.

## The second surface (92-4 – 92-6)

The roster is not the only place chalk names a person, and it was not the place
with the worst tooltip. The message feed sizes its sender column to the widest
label in view and **caps it at 10 characters** (`senderColCh`, phase 9.7k), so
a long handle is ellipsis-truncated on every row it sends. The only way to read
it was the browser's native `title` — which also carried the account and device
ids, and which is the thing 92-1 had already decided was not good enough
anywhere else.

So the card moved out of `Sidebar` and onto both.

### What is shared, and what is not

`components/HoverCard.tsx` holds `useHoverCard<T>()` — the open card, the
rest timer, the anchor clamp, the close-on-scroll and close-on-Escape
listeners — and `PersonCard`, which draws a resolved card. Everything that
decides *what a card says* stays in `chat/hovercard.ts`, where it is testable
without a browser: `rosterCardInfo` and `senderCardInfo` both return a
`PersonCardInfo` whose null fields mean "draw no line".

Two things deliberately differ per surface:

- **Placement.** The roster's card sits to the right of the row, because what
  is to the right of the sidebar is the feed's margin. The feed's sits *below*
  the name, because what is to the right of a sender name is the message you
  are hovering it to read.
- **The presence line.** The roster always has one: presence subscriptions are
  friends-only server-side, so a roster row's absent entry genuinely means
  offline. A channel member need not be a friend, so in the feed an absent
  entry means *we were never told*, and the card draws no line rather than
  printing a guess as a fact. The distinction is why `PersonCardInfo.state` is
  `string | null` and not just a state word.

`presenceClass` / `presenceLabel` moved from `Sidebar.tsx` to
`chat/presence.ts` in the same slice: the card draws its own dot, and Sidebar
imports the card, so leaving them where they were made that a cycle.

### Where the display name comes from (92-5)

Nothing on the wire carries it. Not the friend list, not a channel's member
list, not `sender_user_id` — chalk's wire knows people by handle, and the
profile display name is an HTTP-API field.

The card reads it from `GET /api/users/directory`, the endpoint 59-1 added for
the friends panel's "everyone on this server" list, wrapped in
`auth/display-names.ts`. That endpoint is already open to any signed-in member
by an explicit decision of 59-1, so this discloses nothing new; the rejected
alternative — widening the friend-list and member-list frames — is three
layers and a policy question per surface to deliver a field two tooltips read.

Two details in that module are load-bearing:

- **A user with no display name is cached as `""`, not left out.** Absent
  means "never resolved" and triggers a refetch; `""` means "resolved, nothing
  to show". Conflating them refetches the directory forever on behalf of
  everyone who skipped the field at signup.
- **The refetch trigger is an unknown id, not a timer.** `useDisplayNames`
  takes the set of user ids whose cards could be drawn — the roster plus the
  open channel's members, minus your own — and fetches again when one of them
  is not in the map. Someone who registered or joined a channel after you
  opened chalk is exactly that case, and it was the first thing the UI probe
  caught: a fetch-once-per-session map is empty of everyone who arrives later.
  Your own name is merged in from `me`, because the directory omits the caller.

### The identity footer

The feed's card keeps what the native `title` said last —
`user 1a2b3c… · device 4d5e6f…` — as a dim footer. It is the only place a
multi-device sender can be told apart, and dropping it while removing the
`title` would have been a quiet loss. The roster has no footer: a roster row
knows a user, not a device.

Accessibility did not regress with the `title`: the truncation is CSS
(`text-overflow: ellipsis`), so the DOM text was always the full handle, and a
screen reader never needed the tooltip. The card is mouse-only in the feed —
a long press there is already the message menu — where the roster also opens
it on `:focus-visible`.

## The slices

- **92-1 — the card.** `Sidebar` grows the hover state, the open/close
  handlers and the card itself; the row's `title` goes away. New CSS block
  beside the roster colour menu it sits next to visually.
- **92-2 — last seen.** `at` survives the trip from the presence push into
  reducer state as `lastSeen`; `web/src/chat/hovercard.ts` owns the one rule
  worth testing (when there is a line and what it says), reusing `fmtRelative`
  so the card ages a timestamp exactly the way the message list and the thread
  inbox do.
- **92-3 — the device line.** Not built. Above.
- **92-4 — one card, two homes.** `components/HoverCard.tsx`
  (`useHoverCard` + `PersonCard`), `chat/presence.ts`, and `Sidebar` rebuilt on
  both with no change to what it shows.
- **92-5 — the display name.** `auth/display-names.ts`, threaded from `App`
  into both surfaces; a second line on every card whose display name is not
  just the handle again.
- **92-6 — the feed's sender card.** `MessageList` opens the card on a 500 ms
  mouse rest over a sender name and drops the `title`; `ThreadPanel` forwards
  the same three maps so a thread reply's card says what the feed's does.

## Left open

- The card's relative time is computed when the card opens and is not ticked.
  A card held open across a minute boundary keeps saying `3m ago`. Live-ticking
  it would mean a timer per open card for a string almost nobody watches change;
  `SearchPanel` and the thread inbox have the same property.
- `ZuckerList` (mobile) still shows presence as a dot and a bare state word.
  Last seen would fit its friend rows, but the gesture budget on touch is spent.
- A display name changed mid-session is not picked up: the refetch trigger is
  an id the map has never seen, and a renamed user's id is one it has. A
  reload gets it. Fixing it properly means the server telling us, which is the
  wire change 92-5 declined.
- The members panel, the voice-room occupant list and the reaction-who card
  name people without a hover card. They are all untruncated, so none of them
  has the problem 92-6 solved; they would be a consistency argument, not a
  legibility one.

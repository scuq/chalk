# Phase 130 — guest flow: a temporary room opens alone

**Status:** built, 130-1 – 130-5 (2026-11-01). Every change is in the client.
**Tags:** `#ephemeral` → `tools/where.sh -g ephemeral`

Phase 80 ships temporary voice rooms and guest magic links. Its record is
[PHASE-80-EPHEMERAL.md](PHASE-80-EPHEMERAL.md).

## The problem

v0.9.1 made the guest side work again. The first real use of the rooms then
showed four rough edges in the flow of the member:

- The create dialog and the guest-links dialog closed on a click on the
  backdrop. A drag that selects text, for example the minted link, can end
  outside the card. Its click then lands on the backdrop and closes the dialog.
- The create dialog required a member, also for a temporary room. A user with
  no friends could not open one. A user who wants to talk to guests only had
  to pick a member who was not needed.
- A temporary room took a full dialog with many choices. The sidebar had no
  short way to make one.
- The guest links were two clicks away, in the members panel.

## The design

The user decided two things. The member requirement falls for temporary rooms
only. The quick create lives on the voice section of the sidebar.

### The rule (130-2)

`web/src/chat/create-rules.ts` is a pure module. `isTemporaryRoom(voice,
ttlSecs)` is true for a voice room with a lifetime. `createSubmitState`
returns `{disabled, error}` for the create button. A temporary room needs no
member and does not wait for the friend list. Every other channel keeps the
rules from before phase 130: wait for the friends, disabled with none, and
"pick at least one member" on submit. `QUICK_ROOM_TTL_SECS` is 8 hours.

`CreateChannelModal.tsx` uses the module for the button and the error. It
also offers 8 hours as a lifetime. When the user has no friends, the hint says
that a temporary room opens without members.

The server needs no change. Reading the code before the change showed three
facts:

- The server removes duplicate member ids and skips the caller
  (`internal/server/ws.go`, around lines 2250 to 2282).
- The store always adds the creator as owner and sets no minimum
  (`internal/store/channels.go`, around lines 176 to 183).
- A lone creator makes the space key and reaches "ready"
  (`web/src/crypto/channel-crypto.ts`, around lines 867 to 926).

### The quick create (130-3)

`Sidebar.tsx` has a new optional prop, `onQuickRoomClick`. The voice section
header now also shows when there is no room yet, because it carries a `+`
button (`sidebar-voice-new`, label "new temporary room"). `App.tsx` wires the
prop only when voice and guest rooms are on.

`QuickRoomModal.tsx` has a name field and the sentence that the room
disappears after 8 hours. It has create, X, and cancel buttons, and Escape
closes it. The backdrop does not.

The submit calls the existing `onCreateChannel` with voice on, the 8-hour
lifetime, no members, and the default group. `quickRoomPendingRef` marks the
request. On the create ack, the quick dialog closes and the guest-links
dialog opens by itself. The room exists to be shared, and the key of the lone
creator is ready at once.

### The dialogs stay open (130-1)

The backdrop of `CreateChannelModal.tsx` and `EphemeralInviteModal.tsx` no
longer closes the dialog. The X, the cancel or footer close button, and
Escape stay.

### The header button (130-4)

In `App.tsx`, `isTemporaryRoomOwner` is true when the active room has an
expiry and the user created it. It feeds two places: the new header button
"⚷ invite guests" (`channel-guest-invites`, class `chalk-channel-guests` in
`web/src/theme.css`, next to the lock indicator), and the existing row in the
members panel. The row stays as the second path.

### Rejected

- A shared click-outside hook. The code has both backdrop patterns. Only
  these dialogs are places where the user types or copies, so only these
  change.
- A change of the server rule. The facts above show that none is needed.

## Slices

| Slice | What it does |
|---|---|
| 130-1 | The create dialog and the guest-links dialog stay open on a click outside. |
| 130-2 | A temporary room opens with no other member. The create dialog offers 8 hours. |
| 130-3 | A `+` on the voice section opens a temporary room with one name, and then the guest-links dialog. |
| 130-4 | An "invite guests" button in the header of the room of the creator. |
| 130-5 | A voice room that the reducer picked by itself no longer joins its call. |

## The start joins a call (130-5)

### The problem

After the user created a temporary voice room on the desktop, every restart
of the app on the phone joined the call of that room.

### The cause

Chalk does not store which channel was active. On every fresh start,
`channels_loaded` in `web/src/state/reducer.ts` makes the newest channel
active. A separate effect in `web/src/components/App.tsx` joins the call
when the active channel is a voice room and its key is ready. Phase 30
added this click-to-join effect (30-5c). It cannot tell a tap of the user
from the default at boot. Its once-per-selection guard lives in memory, so
every start armed it again.

The room being temporary played no part. It was the newest channel. The
desktop did not show the fault because it lands on the parking lot (phase
53). The phone lands on the conversation (79-8). The only voice default is
"join muted", which controls the microphone.

### The options

The user chose between three options:

- Change the boot default. Rejected: a user who parks on a voice room on
  purpose would land somewhere else. It also treats the symptom. The boot
  pick would still look like a selection to every other consumer.
- Add a switch for each device. Rejected: it would turn off click-to-join
  for users who want it, to work around a trigger that was wrong. A switch
  can still come later as its own choice.
- Fix the trigger. Chosen: the effect must join only after a selection.

### The flag

`activeChannelAutoPicked` in `web/src/state/types.ts` starts as false. It is
true while `activeChannelID` is a fallback that the reducer chose, and false
after the user picks a channel. The effect in `App.tsx` returns early while
the flag is true.

These cases set the flag:

- `channels_loaded` sets it when it falls back to the newest channel. It
  keeps the value when the previous active channel still exists.
- `channel_removed` sets it when it falls back to the next channel.
- `channel_added` sets it when no channel was active. A pending DM is a
  selection, so it clears the flag.

These cases clear the flag:

- `set_active_channel` and the open-thread action.
- `set_active_channel` for the channel already on screen. Before, this
  action did nothing. Now it clears the flag, so a click on the room that the
  reducer picked joins it like any other click.

The rejoin hint of the same tab (30-5h and 30-5i) is a different path. It
uses `sessionStorage`, which a successful join in that tab writes. This slice
does not change it.

### Verification

- `npx tsc --noEmit` passes.
- `node test.mjs` passes with 1692 tests. `web/src/state/reducer-autopick.test.ts`
  holds five of them.
- A browser probe ran against the dev stack on 2026-11-01, with 8 of 8
  checks. It checked these points:
  - A room made from the voice `+` joins its call, because that is a
    selection.
  - After a page reload, the call is not joined and `voice_participants` is
    empty, while the room is the newest channel.
  - A click on the room in the sidebar joins its call.
  - Expiry removes the room.

## Verification of 130-1 to 130-4 (2026-11-01)

- `npx tsc --noEmit` passes.
- `node test.mjs` passes with 1687 tests. `web/src/chat/create-rules.test.ts`
  holds five of them.
- A browser probe ran against the dev stack, with 24 of 24 checks. The probe
  is a scratch file and is not committed. It checked these points:
  - A new account with no friends quick-creates a room from the voice `+`.
  - Both dialogs survive a click outside.
  - The guest-links dialog opens by itself and mints a link.
  - The header button shows for the creator and opens the dialog. Escape and
    the X close it.
  - The full dialog is disabled for a permanent channel with no friends. It
    is enabled for a temporary room, offers 8 hours, and creates a room with
    the creator as its only member.
  - A guest joins from the link, and both directions of the scratchpad read as
    exact text.
  - Expiry removes both rooms.

## Open

- The phone list (`ZuckerList.tsx`) keeps voice rooms behind a collapsed row
  and has no section header. It has no quick-create `+` yet.
- Nobody probed a member who is not the creator for the absence of the header
  button. The condition is the same expression that the members panel used
  before this phase.

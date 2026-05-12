# chalk phase 08c — apply notes (handles in welcome, channel members, friend picker)

Small UI polish phase. Surfaces existing `users.handle` data in:

- The status badge (`you (alice)` instead of just `you`)
- DM channel labels in the sidebar/header (`@bob` instead of `@00000b0b`)
- The friend picker (`@bob` instead of `@00000b0b`)

No new database columns; the `handle` field has been in `users` since
migration 0001. We're just plumbing it through to the wire and the SPA.

## What's in the archive

```
internal/store/users.go                 NEW (HandlesByID batched lookup)
internal/server/ws.go                   REPLACES (welcome includes handle)
internal/server/ws_phase08.go           REPLACES (channelSummaryFromStore takes handles map)
web/src/proto.ts                        REPLACES (WelcomePayload.handle, ChannelSummaryWire.members)
web/src/state/types.ts                  REPLACES (Friend.handle, ChannelMember, user.handle)
web/src/state/reducer.ts                REPLACES (welcome stores handle)
```

Plus in-place patches via the applier:

```
internal/proto/proto.go                 PATCH  (WelcomePayload + Handle field)
internal/proto/frames_phase08.go        PATCH  (ChannelSummary + Members, new ChannelMember struct)
web/src/components/App.tsx              PATCH  (onWelcome passes handle, wireToChannel pulls members, friends_loaded reads handle, displayName prefers handle)
web/src/components/StatusBar.tsx        PATCH  (renders "you (handle)" when handle set)
web/src/components/FriendPicker.tsx     PATCH  (renders @handle, falls back to slice(-8))
```

## Prerequisites

- Phase 08b complete
- Phase 08b polish + polish-display applied (the patches depend on
  post-polish app state for some sed-style matches)

## Apply

```sh
bash apply-phase08c.sh
```

## What you'll see after applying

- Status badge top-right: `online you (alice)` (hover for full UUID)
- Sidebar/header DM label: `@bob DM`
- Friend picker: `@bob` row
- Messages: still labeled `you` / `<device-id-suffix>` — message frame
  doesn't carry handles, deferred to phase 09 along with usernames

## Known limitations

- Message sender label still shows device-id suffix for others. The
  message frame would need an additional `sender_user_id` field (and
  matching handle lookup on hot path) which is touchy enough to defer
  to phase 09.
- Handles aren't unique-stable: the `users.handle` column is a CITEXT
  UNIQUE that anyone can theoretically change (no UPDATE path exists
  yet). Phase 09 will introduce a proper username lifecycle.

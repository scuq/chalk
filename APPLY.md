# chalk phase 08b — apply notes (SPA channels + subscribe_channel)

Phase 08b is the SPA half of phase 08. Adds:

- Two-column layout: sidebar (channel list + create button) + main pane
- Channel switching, with history-on-switch via fetch_history
- Create channel modal with friend picker (uses friend_list frame)
- New `subscribe_channel` wire frame so the SPA can pick up newly
  created channels mid-session without reconnecting
- Playwright spec for the cross-tab create-and-receive flow

## What's in the archive

```
internal/proto/frames_phase08b.go         NEW
internal/server/ws_phase08b.go            NEW
internal/server/ws.go                     REPLACES (adds connSubs + subscribe_channel dispatch)
web/src/proto.ts                          REPLACES (phase 08 + 08b wire types)
web/src/state/types.ts                    NEW
web/src/state/reducer.ts                  NEW
web/src/components/App.tsx                REPLACES (channel-aware)
web/src/components/Sidebar.tsx            NEW
web/src/components/CreateChannelModal.tsx NEW
web/src/components/FriendPicker.tsx       NEW
web/src/components/MessageList.tsx        REPLACES (uses Message domain type)
web/src/theme.css                         REPLACES (sidebar/modal styles)
test/e2e/channels.spec.ts                 NEW
test/integration/channels_test.go         PATCHED in-place (subscribe_channel instead of reconnect)
bootstrap/phase-08b-channels-spa.sh       NEW
```

## Prerequisites

- Phase 08a complete (`.bootstrap/phase-08.done` present)
- Node 18+ for SPA build + Playwright

## Apply

```sh
bash apply-phase08b.sh
```

## Behavioral changes

- The SPA no longer auto-shows the default channel; it shows whatever
  channels you're in. On first run for a new user with no channels,
  you see a "no channels yet" message.
- Sending requires an active channel. The composer is disabled when
  no channel is selected.
- Creating a channel requires having friends to add. Since there's no
  friend-management UI yet, friends are pre-seeded via fixtures (or
  via manual SQL). Realistic flow lands in phase 09 or later.

## Known limitations of 08b

- **No friend management UI.** You can create channels with friends
  from the fixture, but adding new friends still requires direct DB
  access. Friends UI is phase 09 territory.
- **No unread badges.** Per-channel unread tracking needs either
  localStorage persistence or a read_ack server roundtrip; both are
  bigger than 08b's scope.
- **No leave/remove member.** Channel membership is immutable after
  creation in phase 08. Future phase.
- **No DM auto-creation.** Sending a DM still requires opening the
  modal and toggling the "direct message" checkbox. A "DM @user"
  shortcut would land naturally with friend-management UI.

## Heads-up: integration test patch

`test/integration/channels_test.go` is modified in place. The
`TestPhase08_MessageFanOutPerChannel` test previously reconnected bob
to pick up the new channel topic; now it uses `subscribe_channel`
which is cleaner and doesn't risk reconnect timing flakes. A backup
of the original is kept by the applier.

# chalk phase 08a — apply notes (backend channels)

Phase 08a is the backend half of phase 08. The SPA still talks to the
default channel as in phase 07; this phase adds:

- `channels.is_dm` flag
- `channel_members` table with the DM cardinality trigger
- Wire frames: `create_channel`, `list_channels`, `fetch_history`,
  `channel_event` push
- Per-channel Postgres NOTIFY topics with dynamic refcounted LISTEN/
  UNLISTEN in the pubsub listener
- WS handlers for the three new client frames + membership-filtered
  fan-out from the dispatcher

Phase 08b will add the SPA sidebar, channel switching, create modal,
and history-on-switch.

## What's in the archive

```
migrations/0010_channel_members.sql       NEW
internal/proto/proto.go                   REPLACES (MessagePayload + SendPayload gain channel fields)
internal/proto/frames_phase08.go          NEW
internal/pubsub/notifier.go               REPLACES (Event gains ChannelEventPayload)
internal/pubsub/listener.go               REPLACES (dynamic Subscribe/Unsubscribe)
internal/pubsub/channel_topics.go         NEW
internal/store/channels.go                NEW
internal/server/ws.go                     REPLACES (subscribe-on-hello, channel-routing handleSend)
internal/server/ws_phase08.go             NEW
internal/server/server.go                 REPLACES (handleChannelEvent + per-channel fan-out)
internal/server/hub_phase08.go            NEW (ForEachConn helper)
test/integration/channels_test.go         NEW
bootstrap/phase-08-channels.sh            REPLACES the stub
```

## Prerequisites

- Phase 07 done (phase 08 requires phase 07's fix 4 ws.go wiring)
- Go 1.23+, Docker, Postgres 16 (same as previous phases)

## Apply

The applier script handles everything. From the repo root:

```sh
bash apply-phase08a.sh
```

The applier:
1. Backs up the 5 REPLACES files
2. Copies all 13 phase-08a files
3. Runs `go mod tidy` + `go build ./...` + unit tests for the new packages
4. Tells you to run `./bootstrap/phase-08-channels.sh` for the integration test

## Behavioral changes

- `MessagePayload` JSON gains `channel_id` and `seq` fields. Phase 07
  SPAs ignore the unknown fields (they only read `id`/`sender`/`ts`/
  `body`); nothing breaks.
- `SendPayload` JSON gains an optional `channel_id` field. Phase 07
  SPAs omit it; the server falls back to the default channel. Phase
  08b SPAs send it explicitly.
- `WelcomePayload.Channels` now contains the user's actual channel IDs
  (was always empty). Phase 07 SPAs don't read this field; phase 08b
  uses it as the initial sidebar state.
- Pubsub now uses per-channel topics for messages. The default channel
  still publishes on `chalk_global` for back-compat. Friend/presence/
  channel-membership events stay on `chalk_global`.

## Known limitations of 08a

- **Newly-created channels require reconnect.** The hello-time
  subscription loop snapshots the user's channels at connect; channels
  created mid-session aren't auto-subscribed. Phase 08b's SPA handles
  this transparently (on receiving `channel_event{kind=added}` it
  reconnects to pick up the new topic). Until then, you'll see the
  `channel_event` notification but not in-channel messages until you
  refresh.
- **No SPA changes yet.** All exercise happens through the integration
  test or manual wscat. The browser still sees the phase 07 single-
  channel view.
- **No add_member / remove_member yet.** Channels are immutable after
  creation. Future phase.

## Heads-up: pubsub listener has a new design

The listener now serializes subscribe/unsubscribe commands through a
buffered channel and drains them between notifications via a short
WaitForNotification timeout (50ms default, tunable via
`Listener.CmdPollInterval`). This is the right design for "one
goroutine owns the dedicated conn" but it adds ~50ms latency to
Subscribe() in the worst case. Tune down if it matters; 50ms is
chosen to balance idle CPU vs subscribe responsiveness.

## Tests

The integration test runs four scenarios:
- `TestPhase08_CreateChannelHappyPath`
- `TestPhase08_CreateChannelRequiresFriendship`
- `TestPhase08_MessageFanOutPerChannel`
- `TestPhase08_FetchHistory`

Run via `./bootstrap/phase-08-channels.sh` (sets up the two-chalkd
environment) or manually:

```sh
CHALK_TEST_PGURL=... CHALK_TEST_HTTP_1=http://... CHALK_TEST_HTTP_2=http://... \
  go test -race -count=1 -v ./test/integration/ -run 'TestPhase08_'
```

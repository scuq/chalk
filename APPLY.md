# Phase 05 fix #4 — fresh-only live broadcast

## Diagnosis from the debug run

A's surprise frame: `"sender":"11dbd44b-...","ts":1778448554140,"body":"hello across instances"`
B's expected frame: `"sender":"5cf810ee-...","ts":1778448554358,"body":"should not echo to A"`

Time delta: 218ms.

Test 2's A received **test 1's** message, sent 218ms before test 2's A even existed. Mechanism:

1. Test 1 sends. Instance 1's listener receives the NOTIFY.
2. Listener calls `s.store.GetMessage(...)`. This is the first time `GetMessage` runs against the partitioned messages table on this pool connection -- prepared-statement compile, planning. Slow.
3. While the listener is blocked inside `GetMessage`, test 1 finishes (B got the message via *instance 2*'s independent listener path). A1 closes; the hub on instance 1 empties.
4. Test 2 starts. A2 dials instance 1, registers in the hub.
5. **Now** instance 1's listener finally returns from `GetMessage` and calls `Broadcast(devA1, wire)`. The hub at this moment contains A2, not A1. devA1 != devA2, so A2 isn't skipped -- A2 receives test 1's old message.

The "except" filter works correctly. The problem is that "exclude the sender" is the wrong semantic when broadcast processing is delayed: we need "exclude the sender AND exclude anyone who connected after this message existed."

## Fix

New `Hub.BroadcastFresh(except, data, messageTS)`. Same as `Broadcast` plus
one extra filter: skip any conn where `c.CreatedAt > messageTS`.

`handlePubsubEvent` now calls `BroadcastFresh(... , msg.TS)`. Conns that
joined after `msg.TS` don't receive that message on the live feed.

This is the right semantic for chat anyway. A user who opens a fresh tab
should not retroactively receive messages from before the tab existed --
they should fetch history explicitly (phase 08).

## Why this is robust

Even on a fast server, the same race exists in slow forms:
- Pool exhaustion under load
- A query plan flip causing GetMessage to slow down briefly
- An MLS commit (phase 10) that requires fetching key material before the message can be decoded
- Cross-region database with higher latency

`BroadcastFresh` makes all of these benign. The live feed represents
"messages sent while you were already connected." Backfill is a separate
concern.

## Apply

```sh
cd ~/chalk
tar xzf chalk-phase05-fix4.tar.gz
bootstrap/run-all.sh --only 05
```

## Files

| File | Change |
|---|---|
| `internal/server/hub.go` | adds `BroadcastFresh` (Broadcast unchanged) |
| `internal/server/hub_test.go` | three new tests for `BroadcastFresh` |
| `internal/server/server.go` | `handlePubsubEvent` uses `BroadcastFresh` with `msg.TS` |
| `test/integration/pubsub_test.go` | keeps the debug `t.Logf` lines (informative on success too) |

## What this doesn't fix

The underlying slowness of `GetMessage` on the first invocation. That's
a perf concern, not correctness. I'd rather not paper over it with
"warm the prepared statement at startup" because the same race appears
in many forms; `BroadcastFresh` addresses the class, not the instance.

## What I missed in earlier attempts

I had the wrong mental model: "the test name is sender-no-echo, so this
is about the sender filter." It wasn't -- it was about a leaked stale
message reaching a fresh connection that happened to have the same role
("A on instance 1") as in the prior test.

The debug Logf output made this obvious in one read. Instrument before
guessing.

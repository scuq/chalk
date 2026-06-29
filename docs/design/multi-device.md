# Multi-device (shared identity key)

Status: implemented and verified (slices md-1, md-2, md-3). Architecture:
**shared identity key** — both devices derive the same X25519/Ed25519
keypair from the same 24-word phrase. No per-device subkeys, no per-device
revocation. This note records what was built, what was already present, the
accepted tradeoffs, and how to live-verify a second device.

## Summary

Multi-device is not a subsystem. chalk's connection, fan-out, presence, and
device layers were already built multi-connection-per-user (for multi-tab,
phase 09a), and the shared-key crypto needs zero changes. A second device is,
to the server, just another connection under the same user — indistinguishable
from a second browser tab. The remaining work was small:

- **md-1 — device-2 onboarding (client).** `IdentitySetupScreen` already
  selects an "enter" mode when the account has a published identity but this
  device lacks it. md-1 turned that into an explicit second-device flow: enter
  the 24-word phrase, validate the checksum, derive the identity, and confirm
  its X25519 public key matches the one already published for the account
  (`classifyEnteredPhrase` in `web/src/crypto/identity-setup.ts`). The key
  match is the load-bearing check — it stops a valid-but-wrong phrase from
  silently forking a divergent identity onto the device. On match the identity
  is saved to this device's IndexedDB (`saveIdentity`); the existing app flow
  then builds the channel crypto and backfills. The screen also surfaces the
  shared-key revocation tradeoff (see below).

- **md-2 — self-echo (server, verify + lock).** A message sent from one device
  already reaches the sender's *other* devices. Echo-suppression keys on the
  originating connection, not the user (`ws.go` sets
  `Event.SenderConnID = conn.ID`), and `broadcastToChannelMembers` includes the
  sender's own user in the channel member set, fanning out via
  `FanOutToUserFresh`, which delivers to every connection of that user except
  the originating one. No production change was needed; the behavior is locked
  by `TestHubFanOutToUserFreshSelfEcho` and
  `TestHubFanOutToUserFreshSkipsLaterDevice`.

- **md-3 — presence + documentation (this note).** Presence already aggregates
  across devices; the relevant behavior is locked by existing tests (below).
  This note documents the accepted tradeoffs and the live test procedure.

## Crypto: unchanged

Space-key wraps are made to the user's X25519 key, and the "does this user hold
a wrap" logic is per-user, so a single wrap serves every device. A second
device deriving the same key from the same phrase unwraps every channel key
identically. Wrapping, rotation, member removal, reshare, and the
`channel_keys` table are untouched. Forward-only/rotation/revocation semantics
all inherit unchanged.

## Presence: aggregates across devices

"Online if any device is online" already holds at two layers:

- **Connection layer (hub).** `Hub.Unregister` removes only the closing
  connection and drops the user from `byUser` only when their last connection
  closes. Verified by `TestHubByUserUnregisterOneLeavesOther` (a `phone` and a
  `laptop` for one user: closing one leaves the user present) and
  `TestHubByUserUnregisterLastDropsSet` (closing the last connection drops the
  user, idempotently).

- **State layer (presence store).** `AggregateUserState` returns the
  max-precedence state across the user's device rows (online > away > offline)
  and the newest `last_seen`. Per-device `last_seen` and per-device-type TTL
  demotion are unchanged.

## Accepted tradeoffs

- **No per-device revocation (shared key).** Every device that holds the phrase
  is equal; there is no per-device sign-out. A lost or compromised device is
  remedied the same way as a leaked phrase: rotate the identity (phase 25
  identity-rotation governance), which re-keys the account and locks out any
  device that does not re-enter the new phrase. The device-2 onboarding UI
  states this explicitly before the phrase is entered.

- **Per-device read / delivery state (v1).** Read and delivery tracking is
  per-device. Reading a message on device 1 does not mark it read on device 2.
  Acks carry `sender_device_id`; convergence to per-user read state is a future
  option, intentionally not built for v1 (each device tracks its own seen
  state — simpler, and acceptable).

- **Per-device verification (safety numbers).** Safety-number verification
  records live in per-device IndexedDB. A new device starts unverified-locally
  for peers that device 1 had verified; each device verifies peers
  independently. Cross-device sync of verification records is a future option,
  not built for v1.

- **Per-device caches.** The attachment cache (ciphertext) and the space-key
  cache are per-device IndexedDB. A second device starts cold and warms
  independently. No correctness impact — these are caches over
  server-authoritative or re-derivable data.

- **Server-authoritative state is shared automatically.** Friends, channels,
  membership, and governance are fetched on connect, so device 2 sees the same
  state as device 1 with no extra work.

## Live two-device test (manual)

The automated tests lock the connection-layer and self-echo guarantees; this
checklist covers the end-to-end behavior on real clients.

1. On device 1, sign in and complete identity setup (generate + save the
   24-word phrase). Send a message in a channel; confirm it appears.
2. On device 2 (a different browser/profile), sign in to the **same** account.
   The identity screen should show "Set up chalk on this device". Enter the
   24-word phrase.
   - A mistyped phrase is rejected as invalid (checksum).
   - A valid phrase for a *different* account is rejected as a mismatch.
   - The correct phrase unlocks; device 2 backfills and can read existing
     encrypted history.
3. With both devices live, send a message from device 1. It should appear on
   device 2 within the normal push latency (self-echo). Send from device 2; it
   should appear on device 1.
4. Presence: with both devices connected, confirm a peer sees the user as
   online. Close device 1 only; the user should remain online (device 2 still
   connected). Close device 2; the user should go offline after the normal
   presence timeout.
5. Revocation: confirm the onboarding UI states that the device has full
   account access and that revocation is via identity rotation.

## Pointers

- Onboarding: `web/src/auth/IdentitySetupScreen.tsx`,
  `web/src/crypto/identity-setup.ts` (`classifyEnteredPhrase`).
- Self-echo: `internal/server/server.go` (`broadcastToChannelMembers`),
  `internal/server/ws.go` (`SenderConnID = conn.ID`),
  `internal/server/hub.go` (`FanOutToUserFresh`).
- Presence: `internal/presence/store.go` (`AggregateUserState`),
  `internal/server/hub.go` (`Unregister`).
- Tests: `internal/server/hub_test.go`
  (`TestHubFanOutToUserFreshSelfEcho`, `TestHubFanOutToUserFreshSkipsLaterDevice`,
  `TestHubByUserUnregisterOneLeavesOther`, `TestHubByUserUnregisterLastDropsSet`).

# Phase 65 — Web Push notifications (iOS PWA + Chrome/Android/desktop)

Push notifications that reach an iPhone home-screen chalk with the app fully
closed, without breaking the E2E privacy model and without any paid accounts.
Planned against v0.5.2. **In progress, as of 14 November 2026** — slices 65-1
to 65-5 are built, and the plan below was revised that day (next section).

## Review of 14 November 2026

Before 65-1 the plan was checked against `docs/threat-model.md` (trust model
revised 2026-08-09) and against the current code. The review changed five
things. The sections below carry the result.

1. **Subscriptions belong to a login session.** Phase 81 made session
   revocation meaningful. A revoked or stolen phone must stop receiving
   who-messages-you notifications, so the subscription dies with the session.
2. **No HTTP push API.** The old decision "HTTP, not WS" is reversed. A
   TLS-terminating man in the middle (claim 3 of the threat model) could swap
   the VAPID key and send forged notifications, or swap the endpoint and
   receive the metadata. The VAPID key and every subscription frame travel
   only over the WebSocket, inside phase 83's inner sealed channel.
3. **Guests cannot subscribe.** Their sessions live in `ephemeral_sessions`.
4. **No per-channel mute for push.** This is an accepted property (see
   Design).
5. **Push is the first third-party contact of chalkd.** The threat model gets
   a section for it in 65-5.

The review also corrected stale file and line references. The code moved
since v0.5.2.

## The problem

The home-screen PWA badge (50-7, `navigator.setAppBadge`) only updates while
chalk is open: iOS runs no background JS for web apps, so the badge freezes
at the last-seen count the moment the app closes, and nothing at all alerts
the user to new messages. Web Push (iOS 16.4+) is the only mechanism that
wakes a closed web app: chalkd sends a push through Apple's relay (FCM for
Chrome), iOS wakes a service worker just long enough to show a notification
and update the badge.

Free end to end: VAPID keys are self-generated (no Apple Developer Program —
that's native-app-only), the Apple/Google relays cost nothing, and everything
stays self-hosted.

## The privacy invariant

**Message plaintext never enters the push pipeline.** Two layers:

1. The server only ever holds ciphertext (`messages.body BYTEA`), so it
   *cannot* put content in a push. Payloads are built by a single
   choke-point function whose input struct has no body field — the type
   system enforces the contract, and a unit test pins it. Only
   server-visible metadata is available: `users.handle`, `channels.name`,
   `is_dm`, `channel_type`, ids, and unread counts derived from
   `channel_seq − channel_reads.last_read_seq`.
2. RFC 8291 encrypts the payload end-to-end chalkd→browser (ECDH P-256 +
   HKDF + AES-128-GCM against the subscription's keys). Apple and Google
   relays see only ciphertext and the endpoint. So "@alice in #general" in
   the payload leaks nothing to the relays; the only place it ever appears
   is the device's own lock screen.

Mentions cannot trigger pushes: mention detection is client-side inside the
ciphertext, invisible to the server by design. This is a feature of the E2E
model, not an oversight.

**What the relays still learn.** Content is hidden completely; metadata only
partly. Unavoidable: the endpoint (Apple minted it, so it knows the device),
the **timing** of every send — a timestamped "this person is being messaged
now", and by far the largest leak — chalkd's source IP, and the VAPID public
key + `sub`, both stable, which cluster every device on an instance as one
deployment with one contact address. Reduced deliberately: `Topic` is a
constant, not a per-channel value, and payloads are padded to a fixed length
(both below), so neither carries a per-channel or per-sender fingerprint.
Push is the first feature where chalkd contacts a third party: Apple and
Google learn timing, chalkd's IP, and the VAPID subject, never content. A copy
of the disk that holds the VAPID private key and the subscription table can
send forged notifications until the key is rotated. No message content is
exposed, so claim 2 of the threat model holds. `chalkctl` gets a VAPID rotate
command in 65-3. The threat-model section itself is written in 65-5, when the
server first sends a push.

Not attempted: timing defence. Decoy pushes are foreclosed by the very rule
in Risks 1 — a cover push showing no notification is a silent push, and ~3
revoke the subscription — and batching real pushes into fixed intervals
trades away the latency that makes push worth having. Accepted for v1: an
observer at Apple learns *when* a chalk user is contacted, never by whom or
about what.

**Future, not foreclosed:** SW-side decryption for real message previews is
mechanically possible — space keys sit in IndexedDB as raw bytes readable
from SW scope (`web/src/crypto/idb.ts`) — but v1 doesn't attempt it
(channel-crypto needs a WS transport for key fetches the SW can't do). The
payload already carries `channel_id` + `message_id`, which is all a future
SW decryptor would need. Such a decryptor must also verify the phase 83
envelope signature against the pins before it shows any text.

## Decisions (settled with scuq, 2026-08-01)

- **Hand-rolled `internal/webpush`**, no new Go deps. RFC 8291 Appendix A
  ships a complete encryption test vector, so correctness is mechanically
  verifiable; VAPID ES256 JWT is ~40 lines over `crypto/ecdsa`.
- **DMs push by default; per-device opt-in widens to all channel messages.**
  Matches the banner defaults (only P4 = DM/mention banners out of the box).
- **No per-channel mute for push** (2026-11-14). Notification rules are sealed
  (`notify_rules_enc`), so the server cannot read them. iOS revokes a
  subscription that receives pushes without showing a notification, so the
  service worker cannot drop one. The owner decided against a server-readable
  mute list. The scope stays `dms` (default) or `all` per device. Accepted
  property: a channel muted in chalk still pushes under scope `all`.

## Design

- **When to push:** only to users with **no device in state `online`** —
  `presence.Store.OnlineUsers` (65-5). A user whose devices are all `away`
  gets pushes (see "Decisions from 65-5"). The first plan used
  `AggregateUserState`, which counts `away` as present.
  Cross-instance-correct (device_presence is the connectivity truth, not the
  per-instance hub). Never to the sender. New messages only; thread replies
  count as messages in their channel; edits/deletes/reactions/voice/typing
  never push.
- **Payload:** `{v, kind, channel_id, message_id, sender_handle,
  channel_name, is_dm, unread}`. Notification title `@handle` (DM) /
  `@handle in #channel`, static body ("New message"), no message text ever.
  **Padded to a fixed plaintext length** before encryption (RFC 8188's
  padding delimiter, which aes128gcm already carries) so ciphertext size is
  constant — unpadded, the length varies with handle and channel-name length
  and weakly fingerprints the sender to the relay.
- **Badge:** payload carries a server-computed count, capped at 99. 65-5
  defines it as the unread DM channels plus the pending friend requests (see
  "Decisions from 65-5"). It is not the unread total of this plan. The SW calls
  `setAppBadge(unread)` next to `showNotification`. No badge-only pushes —
  Apple revokes subscriptions after ~3 pushes with no visible notification,
  so every push shows one, and the SW handler fail-safes to a generic
  notification even on a parse error.
- **Send hook:** in `handleMessageEvent` (internal/server/server.go:551),
  guarded by `ev.InstanceID == s.instanceID` so only the publishing instance
  pushes (every instance receives the NOTIFY; without the guard each would
  push a duplicate — pin with a test, single-instance dev never surfaces
  it). The function has no instance guard today. The guard is new work in
  65-5. The send path already sets `Event.InstanceID`
  (internal/server/ws.go:1106-1121). Hands off to an async dispatcher (buffered chan + small worker pool +
  per-(user,channel) ~60 s cooldown) so relay latency never blocks WS
  fan-out. Headers: `Topic` = the constant `"chalk"`, `TTL` 24 h,
  `Urgency: normal` — all three identical on every push, so the header set
  carries nothing. `Topic` is unencrypted, so a per-channel value (the
  obvious base64url(channel UUID)) would hand the relay a stable
  pseudonymous channel identifier, correlatable across every member's
  device. A constant also collapses harder: the relay replaces undelivered
  same-topic pushes, so a whole offline backlog becomes one notification
  instead of one per channel. Accepted cost — after a long offline stretch
  the lock screen shows only the most recent sender; the badge total is
  still right.
- **Subscriptions:** `push_subscriptions(id, user_id, session_token,
  endpoint TEXT UNIQUE, p256dh, auth, scope CHECK (scope IN ('dms','all')),
  generic, created_at, last_used_at)` (migration 0063).
  `session_token` is UNIQUE and references `sessions(token)` with ON DELETE
  CASCADE. Logout, password change, recovery reset, factor rotation, admin
  block, and the hourly expiry sweep therefore delete the subscription. A
  session holds at most one subscription. An endpoint belongs to at most one
  session, and a session that claims an endpoint takes it over. The dispatch
  query also applies the session validity test, so an expired session stops
  pushes before the sweep deletes its row. The cap is 8 per user. The store
  has no evict-oldest precedent (the precedent is refuse-at-cap). 65-1 evicts
  the oldest on purpose, because a stale phone must not block a new one. The
  sender prunes a row on relay 404/410. Scope lives on the row, not in prefs:
  the server must read it to filter, and prefs JSONB is client-owned by
  convention.
- **Guests cannot subscribe.** Guest sessions live in `ephemeral_sessions`,
  which the table does not reference. `chalk_guest` gets no grant. The catalog
  test `TestGuestGrantMatrix` (internal/store/grants_test.go) covers the new
  table without an edit. The upsert also requires
  `users.guest_channel_id IS NULL`.
- **API: WebSocket only, inside the sealed channel** (reverses the decision
  of 2026-08-01). The VAPID public key and the subscribe, unsubscribe, and
  state frames travel only over the WebSocket, inside phase 83's inner sealed
  channel. There is no `/api/push/*` route. `/api/auth/config` carries at most
  the boolean `push_enabled`, not the key (`configResponse`,
  internal/auth/http.go:345-368, `handleConfig` at :376). The connection
  carries its session token, so a frame binds to the session without a
  cookie. When the browser replaces a subscription while chalk is closed
  (`pushsubscriptionchange`), the service worker resubscribes locally. The
  page uploads the new subscription over the WebSocket at the next start. At
  every start the page compares `PushManager.getSubscription()` with the
  server's row and uploads on a mismatch. Accepted cost: pushes are lost
  between the change and the next start. The service worker reads the VAPID
  key from the old subscription's options or from IndexedDB, never from plain
  HTTP.
- **SSRF:** subscription endpoints are attacker-controllable URLs chalkd
  POSTs to. https-only + dial-time IP vetting — copy the ~40-line vet from
  `internal/linkpreview` (`vetDialAddr`, unexported there) into
  `internal/webpush`; extract a shared package only if a third user appears.
  Built in 65-2. The sender uses no proxy, because a proxy would make the
  vet check the address of the proxy and not the address of the endpoint.
  The sender follows no redirect. It returns a redirect as a `StatusError`.
- **Sender record (65-2):** the plaintext is always 1024 bytes, with the
  delimiter and the padding. Every body is therefore 1126 bytes. The record
  size in the header is 4096. A VAPID token lives 12 hours, and the sender
  replaces it 1 hour before it expires. The token cache holds at most 64
  audiences, because the endpoint host comes from a client. The answers 404
  and 410 map to `ErrGone`.
- **VAPID config:** `internal/config/push.go` sub-config module (pattern:
  linkpreview.go): `CHALK_PUSH_ENABLED`, `CHALK_VAPID_PUBLIC_KEY`,
  `CHALK_VAPID_PRIVATE_KEY`, `CHALK_VAPID_SUBJECT`. The subject is the JWT's
  `sub` claim and must be a `mailto:` or `https:` contact URL — Apple
  rejects tokens without a valid one (`BadJwtToken`), so it is not optional
  on iOS. Unlike the keypair it cannot be generated: it is the operator's
  own contact, so chalkctl takes it from the `--push-subject` flag or the
  `PUSH_SUBJECT` config key and defaults to `https://<instance domain>`.
  chalkctl has no interactive prompt for values, so the plan to prompt on init
  was dropped in 65-3. chalkctl generates on init, preserves on
  `--force`, backfills on `update` — the `ensureTOTPEncKey` pattern
  (internal/chalkctl/secret.go:96) — plus a `{{- if}}`-gated block in
  `internal/chalkctl/templates/chalk.env.tmpl`. Nil dispatcher when keys are absent
  (cmd/chalkd/main.go:185-231 nil-client pattern). Rotating the keypair
  invalidates every subscription; hence preserve. A `chalkctl` VAPID rotate
  command (65-3) is the recovery when the private key leaks.
- **Service worker:** `web/src/sw.ts`, tiny, dependency-free, **no fetch
  handler** (no offline/caching — the SPA stays network-served, the SW
  cannot break serving): `push` → showNotification + setAppBadge;
  `notificationclick` → focus an existing client or `openWindow('/')`
  (opening the right chat is 65-9);
  `pushsubscriptionchange` → re-subscribe locally and mark the subscription
  for upload by the page. Built by a second
  esbuild invocation in web/build.mjs (iife, no splitting) to **unhashed**
  `dist/sw.js`, excluded from `assertNoUnhashedRefs`; served with a
  special case in internal/server/spa.go bypassing the unconditional
  `immutable` cache header (spa.go:205) → `Cache-Control: no-cache` (precedent: `serveIndex`, spa.go:265). CSP
  already allows it (`worker-src 'self'`, spa.go:111, in the block at
  :102-117).
- **Client:** `web/src/notify/push.ts` (register, capability + iOS-standalone
  detection, subscribe/unsubscribe/getState over the WebSocket, logout cleanup) and a new
  "Push" section in NotificationsPanel (permission button already there,
  `web/src/components/NotificationsPanel.tsx:168-175`): per-device toggle bound to the real
  `PushManager.getSubscription()` state, DMs-only/all radio, disabled-state
  explanations, "Add to Home Screen first" hint on iOS outside standalone.
  `web/manifest.json` exists (`display: standalone`), so the iOS
  installed-app precondition is met.
  iOS lists the installed app under Settings > Notifications only after the
  permission prompt. The app never shows in the main list of apps or in the
  Privacy lists. Today the only caller of `Notification.requestPermission()` is
  the button at `web/src/components/NotificationsPanel.tsx:168-179`. The panel
  shows it only when `"Notification" in window` (`web/src/notify/banners.ts:129-131`).
  Unknown: if that button shows in the installed iOS app. The comments at
  `banners.ts:16-20` and `NotificationsPanel.tsx:18-21` say iOS has no
  `Notification`, but no device test confirms it.
- **Notification click:** nothing opens a given chat at start today. When
  chalk is open, the in-app banner handler
  (`web/src/components/App.tsx:2249-2255`) is the entry to reuse. Opening the
  right chat from a closed app, including the phone's chat screen (phase 135
  history stack), is new work in 65-9.

## Slices

| Slice | What | Files | ~LOC |
|---|---|---|---|
| 65-1 (built) | Migration `0063_push_subscriptions.sql` + `internal/store/push.go`: session-bound upsert with the 8-per-user cap, get/delete by session, delete by id, touch, `ListPushSubscriptionsForUsers(userIDs, isDM)` with scope and session-validity filter, tests | migrations/, internal/store/ | 280 |
| 65-2 (built) | `internal/webpush`: RFC 8291 aes128gcm encrypt w/ fixed-length padding, RFC 8292 VAPID ES256 JWT (`aud` = origin of *this* endpoint, computed per-send, not a fixed value and not chalk's own origin — a cached token is reusable only across subscriptions sharing a host), https-only sender with IP vet, Topic/TTL/Urgency, typed ErrGone; tests incl. the Appendix A vector byte-exact and constant ciphertext length across differing handles | internal/webpush/ (new) | 450 |
| 65-3 (built) | Config + chalkctl: `internal/config/push.go`, VAPID keygen/preserve/backfill + `CHALK_VAPID_SUBJECT` (flag or config key, domain-derived default, preserved like the keys), `chalkctl push status\|enable\|disable\|rotate-key --yes`, env template, `push_enabled` only in /api/auth/config. chalkd builds the sender only if push is enabled, and `server.Options.Push` holds it. Nothing calls it before 65-4 and 65-5 | internal/config/, internal/chalkctl/, internal/auth/ | 290 |
| 65-4 (built) | WebSocket frames inside the sealed channel: `push_state`, `push_subscribe`, and `push_unsubscribe`, each answered by `<type>_ack`. The connection carries its session token. Guests are refused. Validation covers the https endpoint and the key lengths. Migration `0064_push_subscription_vapid_key.sql` adds `vapid_key`. Replaces the old HTTP API slice | internal/server/, internal/proto/, internal/store/, migrations/, web/src/proto.ts | 220 |
| 65-5 (built) | Dispatcher + send hook: payload builder (the plaintext choke point), recipient selection via presence, encrypt/send/prune, cooldown, InstanceID-guarded hook in handleMessageEvent, tests against an httptest fake relay, the new "third parties" section in `docs/threat-model.md` | internal/server/push_dispatch.go, internal/server/server.go, internal/presence/store.go, internal/store/push.go, docs/threat-model.md | 340 |
| 65-6 | `web/src/sw.ts` + second esbuild invocation → unhashed dist/sw.js + spa.go no-cache special case, `pushsubscriptionchange` resubscribes locally and marks the subscription for upload | web/src/, web/build.mjs, internal/server/spa.go | 165 |
| 65-7 | Client push manager `web/src/notify/push.ts`: subscribe and reconcile over the WebSocket at every start, logout cleanup, tests | web/src/notify/ | 210 |
| 65-8 | NotificationsPanel "Push" section. **Changelog bullet.** | web/src/components/ | 150 |
| 65-9 | Notification click opens the chat (open app, closed app, phone), real-device hardening + payload-contract doc update + changelog | small diffs | 80 |
| 65-10 (optional, deferred) | "Hide details" lock-screen mode (generic "new activity" text). `generic` column ships in 0063 up front so no second migration. | — | 60 |

Total ≈ 2,100 LOC, roughly half tests — comparable to the phase-31 or
phase-57 arcs. Each slice passes the full verify chain independently.

## Verification

Locally verifiable (no device, no deployment):

- `CHALK_TEST_PGURL=... go test ./internal/store/ -run TestPushSubscriptions`
  (7 subtests; they pass in 65-1).
- `go test ./internal/webpush/` (8 tests; they pass in 65-2).
- `go test ./internal/server/ -run 'TestParsePushSubscribe|TestPushStatePayload|TestGuestFrameAllowlist'` (they pass in 65-4).
- `CHALK_TEST_PGURL=... go test ./test/integration/ -run TestPushFramesEndToEnd`
  (65-4). It uses a real chalkd, the dev Postgres, a real session cookie, and
  the real sealed handshake.
- The RFC 8291 Appendix A vector reproduces byte-exactly — the strongest
  crypto signal; if the vector passes, iOS will decrypt.
- Dispatcher with a fake store and a fake sender (`go test ./internal/server/
  -run TestPush`, 65-5): recipients, payload, DM scope, skips, cooldown,
  prune on `ErrGone`, instance guard, full queue, stop with the context, and
  payload size. The `PushBadges` and `OnlineUsers` subtests in
  `TestPushSubscriptions` need `CHALK_TEST_PGURL`. The plan to test against
  an httptest relay does not work, because the sender refuses loopback addresses.
- `curl -I /sw.js` → no-cache; hashed assets still immutable; the build's
  hash assertion still protects everything else.
- **Headed Chrome on localhost**: the full real loop through FCM —
  subscribe in the panel, close the tab (Chrome still running), send a
  message from a second account, notification appears. Headless
  Chromium/Playwright cannot receive real pushes; it can only verify SW
  registration, panel states, and the subscribe→server-row round-trip over the WebSocket. A subscribe frame
  from a guest session must fail.

Requires real hardware:

- iPhone (iOS ≥16.4) against a deployed HTTPS instance (Apple's leg has no
  simulator support): add to Home Screen → grant permission via the panel
  (user gesture inside the installed app) → force-close → DM from another
  account → lock-screen notification + icon badge → tap opens chalk. Also:
  Topic collapse (3 fast sends while the phone is offline → 1 notification;
  with the constant topic this must hold across *different* channels too,
  badge still showing the full count), subscription survives relaunch.
  After the grant, chalk shows under Settings > Notifications.
- Android Chrome: same flow, one pass.

## Decisions and open points from 65-3

- **Update leaves push off.** `chalkctl update` backfills the key pair, the
  subject, and `CHALK_PUSH_ENABLED=false`. It also writes `PUSH_ENABLED=false`
  to the chalkctl config file if that file exists and has no such key. Then a
  later `init --force` does not turn push on from the default. Push contacts
  the services of Apple and Google, so the operator turns it on with
  `chalkctl push enable`. A fresh `init` writes it on. Each user still opts in
  for each device.
- **Resolved in 65-4: rotation leaves stale rows.** After
  `chalkctl push rotate-key --yes`, the rows of devices that have not opened
  chalk again stay in `push_subscriptions`, and pushes to them fail. 65-4
  stores the public key for each subscription (see the next section).
- **Restore carries the pair only as a whole.** If the archive holds one half,
  the pair that `init` generated stays.

## Decisions from 65-4

- **Frames.** `push_state`, `push_subscribe`, and `push_unsubscribe`. The
  wire types are in `internal/proto/push.go` and `web/src/proto.ts`.
- **The ack carries the state.** Each request gets `push_state_ack`,
  `push_subscribe_ack`, or `push_unsubscribe_ack`. All three carry a
  `PushStatePayload` (`enabled`, `vapid_public_key`, `subscribed`,
  `endpoint`, `scope`, `key_current`). The page always gets the server's view
  and does not infer it.
- **Four error codes.** `push_disabled` (only `push_subscribe` answers with
  it), `push_unsealed`, `push_no_session`, and `push_key_stale`.
- **Sealed only.** A connection without the phase 83 sealed channel gets
  `push_unsealed` for all three frames. A guest, or a connection without a
  session token, gets `push_no_session`. The guest fence allowlist has none of
  the frames, so a guest never reaches the handler.
- **Session binding.** The connection holds the raw session token in process
  memory. The upsert checks again that the session is live and not a guest.
  A logout in another tab does not close the socket, so a later subscribe on
  that socket gets `push_no_session`.
- **Validation.** The endpoint must be https and at most 2048 bytes. `p256dh`
  must be a 65-byte P-256 point. `auth` must be 16 bytes. The scope must be
  `dms` or `all`. The browser must have used the current VAPID key, or the
  answer is `push_key_stale`.
- **The `vapid_key` decision.** The open point from 65-3 had two options:
  store the key, or delete rows on rotation. 65-4 stores the key. Each row
  holds the VAPID public key the browser subscribed with.
  `UpsertPushSubscription` and `ListPushSubscriptionsForUsers` take a
  `vapidKey` argument, and the list returns only the rows that match. A row
  from before 0064 has the empty key and matches no key. The page sees
  `key_current` false in the state and subscribes again.
- **For 65-5.** The dispatcher must pass the current VAPID public key to
  `ListPushSubscriptionsForUsers`. A wrong key lists no row.

## Decisions from 65-5

- **The hook.** `Server.handleMessageEvent` calls `onMessage` for each new
  message event. The dispatcher queues the event only if `InstanceID` is this
  instance. Every instance that listens on the channel receives the event, and
  only the publisher pushes, so each message is pushed once. `onMessage` never
  blocks the pubsub listener: the queue holds 256 events, and a full queue
  drops the event and logs. Four workers run, joined to the `Serve` wait group
  and stopped by its context, with 30 seconds for each event.
- **Away users get pushes.** The recipients are the channel members other than
  the sender who have no device in state `online`. A user whose only devices
  are `away` (an idle desktop, a phone in the background) gets pushes. This
  closes the "active-looking desktop" gap of the first plan.
  `presence.Store.OnlineUsers` is a batch query for this.
- **Scope.** Direct messages go to every scope. Other channels go only to
  scope `all`.
- **Skipped channels.** The default channel has no members, so it never
  pushes. The chat of a voice room never pushes, as the app badge also leaves
  voice rooms out.
- **Thread replies and guests.** A thread reply pushes like a message and
  carries `thread_id`. A message from a guest pushes to the members like any
  other message. The sender handle is then the display name of the guest.
- **Cooldown.** At most one push per user and channel in 60 seconds. The
  dispatcher decides once for each user, so all devices of a user get the same
  pushes. The count is in memory in each process. This fits because only the
  publishing instance pushes, but a restart resets the count, and messages
  that different instances publish are counted apart.
- **Payload.** `pushPayload` has the fields `v`, `kind` (always `message`),
  `channel_id`, `message_id`, `thread_id` (replies only), `sender_handle`,
  `channel_name`, `is_dm`, and `unread`. It has no field for content, and a
  test asserts that the ciphertext body never reaches it. `channel_name` is
  empty for a DM, because the stored name of a DM is a client label and the
  title of a DM push is the sender. Names are cut at 80 runes, so the payload
  always fits the 1023-byte limit (a test checks it). The headers are
  constant: `Topic` `chalk`, `TTL` 24 hours, `Urgency` `normal`.
- **Badge definition (a deviation from the plan).** `store.PushBadges` counts
  the DM channels with unread messages plus the pending friend requests to the
  user, at most 99 (`MaxPushBadge`). The plan said "unread total". The app
  badge also counts mentions and threads. Mentions are sealed, and thread
  state is not in the query, so the server cannot see them. The number can
  therefore be lower than the number in the app. The app corrects it when it
  opens. This is a decision to keep: a server count of all channels would
  show a number that the app never shows.
- **Results.** On success, the dispatcher touches the subscription
  (`TouchPushSubscription`). On 404 or 410 (`ErrGone`) it deletes the row.
  After any other error it only logs.
- **Threat model.** The section "Third parties: web push (phase 65)" of
  `docs/threat-model.md` is written.
- **Still open: the end-to-end check.** No automated test covers the path from
  a real NOTIFY to a real push service. The sender refuses loopback, so the
  check needs a real browser subscription. Do it in headed Chrome through FCM
  from 65-7 onward, and on a real iPhone in 65-9.

## Risks

1. **Apple revocation:** ~3 pushes without a visible notification kill the
   subscription silently → SW fail-safes to a generic notification;
   `pushsubscriptionchange` re-subscribes.
2. **SSRF** via attacker-supplied endpoints → https-only + dial-time IP
   vetting in 65-2; must not regress.
3. **Multi-instance duplicate pushes** → InstanceID guard, pinned by a test.
4. **Unhashed sw.js** is a deliberate exception to the
   filename-identifies-bytes promise → no-cache header, tightly scoped
   build exception.
5. **Stale `online` presence** suppresses pushes until the demotion sweep
   runs — accepted; the sweep interval bounds the miss window.
6. **Lost pushes after a browser-side subscription change:** the page
   uploads the new subscription only at the next start, so pushes in between
   are lost. Accepted (see Design).
7. **Muted channels still push under scope `all`:** accepted (see Design).
8. **Forged notifications from a stolen VAPID key:** no content is exposed.
   Rotate the key with the 65-3 command.

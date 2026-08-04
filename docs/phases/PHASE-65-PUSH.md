# Phase 65 — Web Push notifications (iOS PWA + Chrome/Android/desktop)

Push notifications that reach an iPhone home-screen chalk with the app fully
closed, without breaking the E2E privacy model and without any paid accounts.
Planned against v0.5.2. **Not started** — this document is the plan.

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
ciphertext, invisible to the server by design (see the migrations/0043
header). This is a feature of the E2E model, not an oversight.

**What the relays still learn.** Content is hidden completely; metadata only
partly. Unavoidable: the endpoint (Apple minted it, so it knows the device),
the **timing** of every send — a timestamped "this person is being messaged
now", and by far the largest leak — chalkd's source IP, and the VAPID public
key + `sub`, both stable, which cluster every device on an instance as one
deployment with one contact address. Reduced deliberately: `Topic` is a
constant, not a per-channel value, and payloads are padded to a fixed length
(both below), so neither carries a per-channel or per-sender fingerprint.
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
SW decryptor would need.

## Decisions (settled with scuq, 2026-08-01)

- **Hand-rolled `internal/webpush`**, no new Go deps. RFC 8291 Appendix A
  ships a complete encryption test vector, so correctness is mechanically
  verifiable; VAPID ES256 JWT is ~40 lines over `crypto/ecdsa`.
- **DMs push by default; per-device opt-in widens to all channel messages.**
  Matches the banner defaults (only P4 = DM/mention banners out of the box).

## Design

- **When to push:** only to users with **no online device anywhere** —
  `presence.AggregateUserState` (internal/presence/store.go:317) != online.
  Cross-instance-correct (device_presence is the connectivity truth, not the
  per-instance hub). Never to the sender. New messages only; thread replies
  count as messages in their channel; edits/deletes/reactions/voice/typing
  never push. Known gap: an active-looking desktop at home suppresses pushes
  while the user is out — acceptable v1, a per-user "always push" pref can
  come later.
- **Payload:** `{v, kind, channel_id, message_id, sender_handle,
  channel_name, is_dm, unread}`. Notification title `@handle` (DM) /
  `@handle in #channel`, static body ("New message"), no message text ever.
  **Padded to a fixed plaintext length** before encryption (RFC 8188's
  padding delimiter, which aes128gcm already carries) so ciphertext size is
  constant — unpadded, the length varies with handle and channel-name length
  and weakly fingerprints the sender to the relay.
- **Badge:** payload carries the server-computed unread total (one aggregate
  over channel_members ⋈ channel_seq ⋈ channel_reads, capped at 99;
  precedent internal/store/channels.go:297-312); the SW calls
  `setAppBadge(unread)` next to `showNotification`. No badge-only pushes —
  Apple revokes subscriptions after ~3 pushes with no visible notification,
  so every push shows one, and the SW handler fail-safes to a generic
  notification even on a parse error.
- **Send hook:** in `handleMessageEvent` (internal/server/server.go:484),
  guarded by `ev.InstanceID == s.instanceID` so only the publishing instance
  pushes (every instance receives the NOTIFY; without the guard each would
  push a duplicate — pin with a test, single-instance dev never surfaces
  it). Hands off to an async dispatcher (buffered chan + small worker pool +
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
- **Subscriptions:** `push_subscriptions(id, user_id, device_id, endpoint
  TEXT UNIQUE, p256dh, auth, scope CHECK (scope IN ('dms','all')),
  created_at, last_used_at)`. Upsert on endpoint (tolerates `chalk.deviceId`
  regeneration on logout), cap 8/user (evict oldest), prune on relay
  404/410, client best-effort delete on logout, re-upload on the SW's
  `pushsubscriptionchange`. Scope lives on the row, not in prefs: the server
  must read it to filter, and prefs JSONB is client-owned by convention.
- **API: HTTP, not WS.** `POST /api/push/subscribe`, `POST
  /api/push/unsubscribe`, session-cookie auth. `pushsubscriptionchange`
  fires inside the SW with no page and no socket — HTTP is mandatory for
  that path, so the whole feature uses it. VAPID public key + `push_enabled`
  ride `/api/auth/config` (precedent internal/auth/http.go:318-323).
- **SSRF:** subscription endpoints are attacker-controllable URLs chalkd
  POSTs to. https-only + dial-time IP vetting — copy the ~40-line vet from
  `internal/linkpreview` (`vetDialAddr`, unexported there) into
  `internal/webpush`; extract a shared package only if a third user appears.
- **VAPID config:** `internal/config/push.go` sub-config module (pattern:
  linkpreview.go): `CHALK_PUSH_ENABLED`, `CHALK_VAPID_PUBLIC_KEY`,
  `CHALK_VAPID_PRIVATE_KEY`, `CHALK_VAPID_SUBJECT`. The subject is the JWT's
  `sub` claim and must be a `mailto:` or `https:` contact URL — Apple
  rejects tokens without a valid one (`BadJwtToken`), so it is not optional
  on iOS. Unlike the keypair it cannot be generated: it is the operator's
  own contact, so chalkctl prompts on init and defaults to
  `https://<instance domain>`. chalkctl generates on init, preserves on
  `--force`, backfills on `update` — the `ensureTOTPEncKey` pattern
  (internal/chalkctl/secret.go:35) — plus a `{{- if}}`-gated block in
  `templates/chalk.env.tmpl`. Nil dispatcher when keys are absent
  (cmd/chalkd/main.go:185-231 nil-client pattern). Rotating the keypair
  invalidates every subscription; hence preserve.
- **Service worker:** `web/src/sw.ts`, tiny, dependency-free, **no fetch
  handler** (no offline/caching — the SPA stays network-served, the SW
  cannot break serving): `push` → showNotification + setAppBadge;
  `notificationclick` → focus an existing client or `openWindow('/')`;
  `pushsubscriptionchange` → re-subscribe + re-upload. Built by a second
  esbuild invocation in web/build.mjs (iife, no splitting) to **unhashed**
  `dist/sw.js`, excluded from `assertNoUnhashedRefs`; served with a
  special case in internal/server/spa.go bypassing the unconditional
  `immutable` cache header (spa.go:205) → `Cache-Control: no-cache`. CSP
  already allows it (`worker-src 'self'`, spa.go:98-119).
- **Client:** `web/src/notify/push.ts` (register, capability + iOS-standalone
  detection, subscribe/unsubscribe/getState, logout cleanup) and a new
  "Push" section in NotificationsPanel (permission plumbing already there,
  :173-175): per-device toggle bound to the real
  `PushManager.getSubscription()` state, DMs-only/all radio, disabled-state
  explanations, "Add to Home Screen first" hint on iOS outside standalone.

## Slices

| Slice | What | Files | ~LOC |
|---|---|---|---|
| 65-1 | Migration `0050_push_subscriptions.sql` + `internal/store/push.go` (upsert w/ cap-8 eviction, deletes, `ListPushSubscriptionsForUsers(userIDs, isDM)` scope filter in SQL) + tests | migrations/, internal/store/ | 280 |
| 65-2 | `internal/webpush`: RFC 8291 aes128gcm encrypt w/ fixed-length padding, RFC 8292 VAPID ES256 JWT (`aud` = origin of *this* endpoint, computed per-send, not a fixed value and not chalk's own origin — a cached token is reusable only across subscriptions sharing a host), https-only sender with IP vet, Topic/TTL/Urgency, typed ErrGone; tests incl. the Appendix A vector byte-exact and constant ciphertext length across differing handles | internal/webpush/ (new) | 450 |
| 65-3 | Config + chalkctl: `internal/config/push.go`, VAPID keygen/preserve/backfill + `CHALK_VAPID_SUBJECT` (prompt on init, domain-derived default, preserved like the keys), env template, `push_enabled` + `vapid_public_key` in /api/auth/config | internal/config/, internal/chalkctl/, internal/auth/ | 290 |
| 65-4 | HTTP subscribe/unsubscribe API + validation (https endpoint, key lengths) + httptest coverage | internal/server/push_http.go | 220 |
| 65-5 | Dispatcher + send hook: payload builder (the plaintext choke point), recipient selection via presence, encrypt/send/prune, cooldown; InstanceID-guarded hook in handleMessageEvent; tests against an httptest fake relay | internal/server/push_dispatch.go, cmd/chalkd/ | 340 |
| 65-6 | `web/src/sw.ts` + second esbuild invocation → unhashed dist/sw.js + spa.go no-cache special case | web/src/, web/build.mjs, internal/server/spa.go | 165 |
| 65-7 | Client push manager `web/src/notify/push.ts` + logout cleanup + SW re-upload path; tests | web/src/notify/ | 210 |
| 65-8 | NotificationsPanel "Push" section. **Changelog bullet.** | web/src/components/ | 150 |
| 65-9 | Real-device hardening + payload-contract doc update + changelog; consider delete-subscription-on-session-destroy | small diffs | 80 |
| 65-10 (optional, deferred) | "Hide details" lock-screen mode (generic "new activity" text). `generic` column ships in 0050 up front so no second migration. | — | 60 |

Total ≈ 2,100 LOC, roughly half tests — comparable to the phase-31 or
phase-57 arcs. Each slice passes the full verify chain independently.

## Verification

Locally verifiable (no device, no deployment):

- The RFC 8291 Appendix A vector reproduces byte-exactly — the strongest
  crypto signal; if the vector passes, iOS will decrypt.
- Dispatcher vs an httptest fake relay: offline user → exactly one POST with
  a valid aes128gcm body; online user → none; sender → never; 410 → row
  pruned. (Test flag to allow loopback through the IP vet — linkpreview
  tests have the precedent.)
- `curl -I /sw.js` → no-cache; hashed assets still immutable; the build's
  hash assertion still protects everything else.
- **Headed Chrome on localhost**: the full real loop through FCM —
  subscribe in the panel, close the tab (Chrome still running), send a
  message from a second account, notification appears. Headless
  Chromium/Playwright cannot receive real pushes; it can only verify SW
  registration, panel states, and the subscribe→server-row round-trip.

Requires real hardware:

- iPhone (iOS ≥16.4) against a deployed HTTPS instance (Apple's leg has no
  simulator support): add to Home Screen → grant permission via the panel
  (user gesture inside the installed app) → force-close → DM from another
  account → lock-screen notification + icon badge → tap opens chalk. Also:
  Topic collapse (3 fast sends while the phone is offline → 1 notification;
  with the constant topic this must hold across *different* channels too,
  badge still showing the full count), subscription survives relaunch.
- Android Chrome: same flow, one pass.

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
6. **deviceId regeneration on logout:** a failed logout-time delete leaves
   an orphan row; endpoint-unique upsert rebinds on next subscribe and
   410-pruning cleans truly dead ones. Server-side delete-on-session-destroy
   is a 65-9 hardening candidate.

# Phase 80 — Ephemeral voice channels with guest magic links

Temporary, expiring voice rooms that people **without a chalk account** can join
from a one-off link, with the guest fence enforced by PostgreSQL rather than by
application discipline. Planned against v0.6.4. **Implemented** (80-1 … 80-15);
this document is the plan it was built from. Where the build deviated, the
as-built section at the end is authoritative.

## The problem

chalk can only talk to chalk accounts. Every principal needs a password, TOTP, a
BIP-39 encryption phrase and an accepted friendship before it can be put in a
channel. That is right for the product's core and wrong for one case: a quick
call with someone who does not have an account and should not have to make one.

Phase 80 adds an *ephemeral* voice channel and the guest principal that makes it
useful:

- It is a voice channel, so it already has a call and a scratchpad.
- It **must** carry an expiry, set at creation, capped by env (default 1 month).
- Its creator mints **one magic link per invitee**, each expiring (capped 24 h).
- Clicking a link joins the call with no signup: pick a display name, done.
- When it expires, everything it held is destroyed — and an operator can destroy
  it sooner, from `chalkctl`, in one audited command.

## What already exists (and so is not built here)

**The scratchpad is already encrypted.** The voice scratchpad is not a separate
feature: it is the voice channel's ordinary `messages` rows, AES-256-GCM under
the channel's space key, hard deleted by `PurgeVoiceScratchIfEmpty`
(`internal/store/voice_scratch.go`) when the last person leaves. The voice
*signalling* is encrypted under the same key, with DTLS fingerprints signed by
the sender's Ed25519 identity key (`web/src/voice/signal-crypto.ts`).

So there is **no new cryptography in this phase.** A guest only has to be a
normal cryptographic principal: a user row, a session, a membership, an identity,
and a space-key wrap. Everything downstream then works unmodified.

**TURN credentials already work for anyone.** `internal/turncred/turncred.go`
mints `username = "<expiry>:<userID>"`, `credential = base64(HMAC_SHA1(secret,
username))` for coturn's `--use-auth-secret` REST scheme, only inside
`handleVoiceJoin` and only **after** `requireVoiceMember`
(`internal/server/voice_ws.go:184`). The shared secret never leaves the server
and coturn relays DTLS-SRTP it cannot decrypt. A guest that is a member of one
channel gets credentials through the identical path.

## The magic link, and the key-substitution problem it solves

A guest's Ed25519 key is minted seconds before use, so nobody can pin it
out-of-band the way the phase-24 safety number pins a real user's. Left naive,
the server could hand members its *own* key in place of the guest's and read the
room. `identity_keys.self_sig` does not help: it proves a key pair is internally
consistent, not that it is the *right* pair.

The link already carries a secret, which closes this:

    https://host/join/<lookup>#<secret>     <- fragment never sent to the server

    creator:  secret  = 32 random bytes
              lookup  = SHA-256("chalk/join-lookup" || secret)[:16]
              seed    = HKDF(secret, "chalk/guest-identity")
              guestPk = X25519(seed), Ed25519(seed)
              guestID = a reserved UUID it allocates itself
              wrap    = wrapSpaceKey(sk, guestPk, channelID, ver, guestID)
    guest:    re-derives the SAME seed from the fragment; the wrap already fits

The creator never asks the server what the guest's key is — it *computed* it. A
substituted key is one the creator did not derive, so the wrap does not open and
the guest decrypts nothing. It also removes the need for a member to be online
when the guest arrives, which the normal `rewrapForMissing` path in
`web/src/crypto/channel-crypto.ts` would otherwise require.

**Redemption proof.** The server holds the guest's Ed25519 public key, so the
guest proves it holds the link secret by signing a server challenge (stdlib
`crypto/ed25519`, constant-time by construction). Nothing secret-derived is
stored server-side, so a database leak yields no redeemable links, and a captured
redemption body is not replayable.

**Enumeration.** Deriving `lookup` from the secret means holding a lookup without
the secret is useless. Returning a challenge unconditionally — including for
unknown lookups, from a keyed PRF — and revealing the channel name only after
verification makes invite existence unobservable, at zero cost.

**The honest residual**, which the join UI must state plainly: *whoever holds the
link is the guest.* A forwarded or shoulder-surfed link is a full credential.
That is inherent to "join with no action", and is why links are capped at 24 h.

## The guest fence is a database invariant, not an allowlist

`POSTGRES_USER=chalk` means chalkd today connects as the **owner and a
superuser**. Owners bypass RLS unless `FORCE ROW LEVEL SECURITY` is set, and
superusers bypass it regardless — so this phase introduces non-owner roles. That
is a deployment change, and good practice independent of the feature.

| role | used by | access |
|---|---|---|
| `chalk` (owner) | migrations only | everything, as today |
| `chalk_app` | chalkd's normal pool | everything the server does today |
| `chalk_guest` | **only** connections serving a guest | see below |

### Why RLS rather than duplicating the shared tables

The entire point of the feature is that **real users and guests are in the same
room** — one voice roster, one scratchpad, one channel. So `channels`,
`messages`, `channel_members`, `channel_keys` and `voice_participants` are
inherently shared. Duplicating them would make every one of those a UNION for the
*real* user's path too, and the voice mesh handshake would span two roster
tables — the fork cost paid on both sides of the wire, forever. RLS gets the
identical guarantee without touching the real user's path at all.

### `chalk_guest` grants

**Full access** — the ephemeral-only tables: `ephemeral_invites`,
`ephemeral_guests`, `ephemeral_identity_keys`, `ephemeral_sessions`.

Guest sessions and guest identities living in their own tables is the strongest
single win: the guest role needs **no grant whatsoever on `sessions` or
`identity_keys`**, so real users' session tokens and identity rows are not merely
policy-filtered, they are unreachable.

**No grant at all**: `user_auth`, `recovery_codes`, `identity_seed_wrap`,
`friendships`, `friend_requests`, `invites`, `preferences`, `attachments`,
`attachment_chunks`, `governance_*`, `email_blacklist`, `device_presence`,
`sessions`, `thread_*`, `message_reactions`.

**Column- and row-scoped:**

- `SELECT (id, display_name)` on `users`, policy: co-members of the guest's
  channel.
- `SELECT (user_id, x25519_pub, ed25519_pub, self_sig)` on `identity_keys`, same
  policy. This is what preserves fingerprint verification — `web/src/voice/call.ts:1203`
  fetches a peer's Ed25519 key to verify DTLS fingerprints, so a guest genuinely
  needs its co-members' public keys, and blocking that would break the anti-MITM
  check on the guest's own call. Today `handleFetchIdentity`
  (`internal/server/ws.go:2858`) serves any user's identity to any authenticated
  connection with no authorization at all; this narrows it, for guests, to the
  people in their room.
- `SELECT/INSERT/UPDATE` on `channels`, `messages`, `channel_members`,
  `channel_keys`, `channel_seq`, `channel_reads`, `voice_participants`, `devices`
  under `FORCE` RLS policies.

### The policy, and why forgetting it fails closed

Each guest transaction opens with

```sql
SET LOCAL chalk.guest_user    = '<uuid>';
SET LOCAL chalk.guest_channel = '<uuid>';
```

and policies read them with the **two-argument** form:

```sql
USING (channel_id = current_setting('chalk.guest_channel', true)::uuid)
```

`current_setting(..., true)` returns NULL when unset, so `channel_id = NULL` is
NULL, the row is filtered, and a transaction that forgot the `SET LOCAL` sees
**nothing at all** rather than everything. That is the correct failure direction
and the reason not to let it raise instead. `SET LOCAL` is transaction-scoped,
which matters because `pgxpool` reuses connections — the setting cannot leak into
the next borrower.

### Type-level safety in Go

Rather than a `s.guestPool` field that a function might reach for by mistake, the
guest path gets its **own store type** holding only the restricted pool:

```go
type Guest struct{ pool *pgxpool.Pool }   // no access to the app pool
func (g *Guest) withTx(ctx, guestUser, guestChannel uuid.UUID, fn ...) error
```

`withTx` always issues both `SET LOCAL`s, so a guest query cannot forget them,
and calling a privileged `*Store` method from the guest path is a **compile
error** rather than a runtime one.

### Where the boundary is drawn

- **Materialization at redemption runs under `chalk_app`.** It is
  server-controlled, not guest-driven, so the restricted role never needs to
  INSERT into `users`.
- **Ongoing guest traffic runs under `chalk_guest`**, which is where a bug could
  otherwise be exploited.
- The application-level fence (frame allowlist, REST path allowlist) still ships,
  but as **defence in depth on top of the database invariant**, not as the
  boundary itself.

## The guest principal

### Ephemeral-ness is a column, not a new `channel_type`

`channel_type` stays `'text' | 'voice'`; an ephemeral channel is a voice channel
with `expires_at` set. A third enum value would silently break four things:
`voice_scratch.go:68` (the scratchpad stops purging), `store.JoinVoice` →
`ErrNotVoiceChannel` (joins rejected), `CreateChannel`'s `ErrBadChannelType`, and
`countsAsUnread` (`web/src/state/types.ts:239`, where the scratchpad-dot
suppression would invert).

### The guest row is materialized lazily, against a reserved UUID

**`handlePublishIdentity` can only ever publish for the calling user.**
`internal/server/ws.go:2824` derives `userID` from the connection and there is no
recipient field in the payload. So "the creator pre-publishes the guest's
identity" would need a new privileged frame letting one user write another's
`identity_keys` row — precisely the primitive the whole self-signature trust
chain exists to avoid.

The fix costs nothing, because `users.id` is a `UUID PRIMARY KEY` with **no
DEFAULT** — the application already supplies it:

- **At mint:** the creator allocates the guest UUID itself and parks
  `guest_user_id`, the three public-key fields and the wrap blob on
  `ephemeral_invites`. No `users` row yet.
- **At redemption:** one `chalk_app` transaction inserts `users`,
  `ephemeral_guests`, `channel_members`, `ephemeral_identity_keys` and
  `channel_keys` from the parked bytes, then mints an `ephemeral_sessions` row.

The reserved UUID is what makes this possible at all: `wrapSpaceKey` binds
`recipientID` into the AAD (`web/src/crypto/spacekey.ts:119`), so the wrap cannot
be computed without knowing the guest's id up front.

Eager creation — inserting the guest row at mint time — was rejected: besides
needing that privileged frame, it would put unredeemed guests into every member's
roster via `ListChannelsForUser`'s bulk member fetch, and into
`/api/users/directory`, which filters only `blocked_at`/`deleted_at`.

A materialized guest row must satisfy the full `users` contract, which is
stricter than it looks: `handle` (UNIQUE, 1–32), `username` (UNIQUE,
`^[a-z0-9_]{3,32}$`), `email` (UNIQUE), `display_name` and `status` are all NOT
NULL. Mint `handle = username = guest_<hex>`, `email = guest_<hex>@guest.invalid`,
`status = 'active'`, and put the typed name in `display_name`.

> **Decide during 80-14:** `channelSummaryFromStore` (`internal/server/ws.go:1855`)
> puts `Members[].handle` on the wire, so members would see `guest_a3f9`. Prefer
> `display_name` for guests. Do **not** make `handle` the typed name — it is
> UNIQUE, so two guests called Bob in one room would collide.

## Deletion cannot rely on cascade

`messages` is `PARTITION BY RANGE (ts)` and its only FK is `sender_device_id →
devices`; channel is **application-enforced** (`migrations/0003_messages.sql:60`).
`attachments` declares `channel_id` with no `REFERENCES` at all
(`migrations/0037_attachments.sql:35`). So `DELETE FROM channels` leaves every
message and attachment behind, in a partition, still holding ciphertext,
unreachable by any cascade. There is also **no `DeleteChannel` anywhere in
`internal/store/`** — this is written from scratch.

`PurgeChannel` deletes in order — governance rows → `attachment_chunks` →
`attachments` → `thread_reads` (no FK into messages by design, 0047) → `messages`
→ the channel row — extending the ordering `voice_scratch.go:83-116` already
proves out. Bound the message delete with `AND ts >= <channel.created_at>` so it
prunes to two partitions instead of probing every monthly one.

**`check_dm_cardinality` will wedge the janitor if left alone.** The trigger
(`migrations/0010_channel_members.sql:52`) is `FOR EACH ROW` and its body scans
*every* DM in the database, unscoped. Deleting a 20-guest room does 20 full
grouped scans in one commit; worse, if **any** DM anywhere has ≠2 members — a
state `store.PurgeUser` can already produce — every transaction touching
`channel_members` fails, so an hourly channel-deleting janitor becomes a
permanently wedged loop failing on a fault it did not cause. Narrow the trigger to
the touched channels in migration 0050.

**Governance FKs are NO ACTION.** `channel_proposals.created_by` and
`governance_votes.voter_id` reference `users(id)` with no `ON DELETE`
(`migrations/0036_governance.sql:63`). Delete governance rows explicitly, fence
`gov_*` frames away from guests, and force `governance_mode = 'dictator'` on
ephemeral channels.

**The FK cycle is legal but load-bearing.** `channels.created_by → users` is SET
NULL while `users.guest_channel_id → channels` is CASCADE. Postgres permits this.
The hazard: if a guest ever became `channels.created_by`, deleting its ephemeral
room would cascade the guest away and leave an ownerless orphan. The fence
prevents it — meaning a *schema* invariant is enforced by an *application*
allowlist. Assert it in a store test.

## coturn hardening

Two gaps, the second live today and not specific to guests:

1. **TTL is not clamped.** `CHALK_TURN_TTL_SECS` defaults to 3600, minted blind.
   Clamp to `min(TurnTTL, until channel expiry, until session expiry)`.
2. **coturn has no peer restrictions.** The Quadlet `Exec=` line in
   `internal/chalkctl/templates/chalk-coturn.container.tmpl` sets no
   `--denied-peer-ip`, no `--no-multicast-peers` and no quotas, so TURN will relay
   to `10.0.0.0/8` — **any credential holder can reach the operator's private
   network**, a port-scan and SSRF pivot. Already true for logged-in users;
   handing credentials to strangers with a link is what makes it unacceptable.

Note `--user-quota` is decorative here: the REST username embeds a rotating
expiry, so it changes on every mint and the per-user quota resets. `--total-quota`
and `--max-bps` do bite. Heed the template's own header — a malformed flag is
silent, so verify with `systemctl cat chalk-coturn` and a real allocation.

## Slices

| # | Scope | Key files |
|---|---|---|
| 80-1 | **Roles.** `chalk_app` + `chalk_guest` with grants; `CHALK_DB_URL` (app) + `CHALK_DB_URL_GUEST`; `chalkctl update` backfills existing deployments; `restore.go` carries roles (they live outside the database) | `internal/chalkctl/{init.go,update.go,restore.go,config.go}`, `templates/chalk.env.tmpl` |
| 80-2 | **Schema.** `channels.expires_at`; `ephemeral_invites`, `ephemeral_guests`, `ephemeral_identity_keys`, `ephemeral_sessions`; `FORCE` RLS policies; **narrow `check_dm_cardinality`** | `migrations/0050_ephemeral.sql` |
| 80-3 | **`store.Guest`** type + `withTx` issuing both `SET LOCAL`s + the **grant-matrix test** | new `internal/store/guest.go`, `internal/store/grants_test.go` |
| 80-4 | `PurgeChannel` ordered hard delete + `EphemeralJanitorLoop` in the `VoiceJanitorLoop` style | new `internal/store/channel_purge.go` (+test), `internal/server/server.go` |
| 80-5 | Config `CHALK_EPHEMERAL_{ENABLED,MAX_TTL,INVITE_MAX_TTL,MAX_GUESTS}`; `Validate()` hard-caps invite TTL at 24 h; the six chalkctl touch points | new `internal/config/ephemeral.go`, `internal/chalkctl/*`, `cmd/chalkctl/main.go` |
| 80-6 | `expires_at` end to end; create handler forces voice + dictator, refuses DM, clamps TTL | `internal/store/channels.go`, `internal/proto/frames.go`, `internal/server/ws.go`, `web/src/proto.ts` |
| 80-7 | Invite mint/list/revoke frames, owner-only, `MaxGuests` cap, TTL = min(24 h, channel expiry) | new `internal/proto/ephemeral.go`, `internal/server/ephemeral_ws.go`, `internal/store/ephemeral_invites.go` |
| 80-8 | Redemption: `GET`/`POST /api/join/{lookup}`, stateless HMAC challenge, Ed25519 verify, one-tx materialization under `chalk_app`, TTL-clamped session | new `internal/auth/join_http.go` (+test), `internal/ratelimit/` (lifted from `internal/linkpreview/ratelimit.go`) |
| 80-9 | **Application fence** (defence in depth): `SessionUser.IsGuest`, the `!su.IsGuest` clause on the 31-9 gate, REST + WS allowlists, bare-handler audit, `AddMember` refusal, `ListDirectoryUsers` exclusion | `internal/auth/sessions.go`, `internal/server/ws.go`, `internal/store/{users.go,channels.go}` |
| 80-10 | TURN TTL clamp + coturn hardening | `internal/server/voice_ws.go`, `templates/chalk-coturn.container.tmpl` |
| 80-11 | **chalkctl ops**: `ephemeral list`, `ephemeral purge`, `ephemeral purge --channel <id>`, `ephemeral disable` (flips the env flag *and* revokes outstanding links) | new `internal/chalkctl/ephemeral.go`, `cmd/chalkctl/main.go` |
| 80-12 | Client guest crypto: secret → HKDF → `deriveIdentity` → `wrapSpaceKey(..., reservedID)`; mint UI | new `web/src/crypto/guest-link.ts` (+test), new `web/src/components/EphemeralInviteModal.tsx`, `CreateChannelModal.tsx` |
| 80-13 | `/join` route: fragment read + **immediate `history.replaceState` strip**, name entry, POST, WS bootstrap | new `web/src/components/JoinScreen.tsx`, `web/src/components/App.tsx` |
| 80-14 | Roster badge + countdown; `channel_event{kind:"deleted"}` push on expiry; `display_name` for guests in channel summaries | `Sidebar.tsx`, `ZuckerList.tsx`, `web/src/chat/zucker.ts`, new `web/src/chat/countdown.ts` (+test) |
| 80-15 | `docs/tags.md`, `docs/deployment.md`, `CHANGELOG.md` | — |

### Notes that change code, not just prose

- **Every future migration must declare grants.** A new table defaults to no guest
  access — correct, fails closed — but a new *shared* table silently gets no
  policy and the guest path breaks at runtime. The 80-3 grant-matrix test is what
  catches this, so it must enumerate tables from `information_schema`, not from a
  hand-written list that drifts.
- **RLS on partitioned `messages`**: policies on the parent apply when querying
  through the parent, which is what the app always does. Verify against the
  deployed PG version as part of 80-2 rather than assuming.
- **Countdown**: one 1 Hz tick in `App`, live only while something expires within
  the hour, coarsening to 60 s beyond — not a `setInterval` in `Sidebar`, which
  would re-render the whole roster every second. CSP is `style-src 'self'`, so the
  countdown drives a **class**, never an inline `style=`.
- **Expiry must push.** Without a `channel_event{kind:"deleted"}` the roster keeps
  a dead row until reload and a guest sits in a live call with a channel that no
  longer exists. Mid-call expiry also needs an explicit kick via
  `internal/server/hub_kick.go`; `SweepVoiceOrphans` only catches crashed conns.
- **Ordering trap**: the space key is bootstrapped lazily and creator-only by
  `ensureChannelKey` on channel *open*. The mint path must `await` it and refuse
  to issue a link while the status is `"waiting"`, or the guest gets a link to a
  room it can never decrypt.

## Open decisions to settle during 80-8

- **Single-use vs reusable-until-expiry.** Strict single-use locks out a guest who
  closes the tab — likely complaint #1. Recommendation: `redeemed_at` records
  first use but does not block; the link keeps minting sessions until
  `expires_at`, always the same identity since it is derived from the secret.
- **`SameSite=Strict`** (`internal/auth/sessions.go:106`) is not sent on a
  cross-site top-level navigation — i.e. clicking the link from a mail client.
  Redemption itself is same-origin so it works, but a later re-click looks logged
  out. May force `SameSite=Lax` for guest sessions specifically.
- **`IPFromRequest` honours `X-Forwarded-For` only in dev**
  (`internal/auth/sessions.go:289`). Behind chalkctl's Caddy the per-IP
  rate-limit bucket is one bucket for the entire internet. This phase is where
  that owed `CHALK_TRUSTED_PROXY` decision comes due.

## Verification

Per slice: `go build ./... && go vet ./... && go test ./... && gofmt -l .`; from
`web/`: `npx tsc --noEmit && node test.mjs && node build.mjs`.

- **`internal/store/grants_test.go`** — the security test. Connect as
  `chalk_guest`, enumerate every table from `information_schema`, assert
  `permission denied` on the forbidden set, co-members-only rows on `users` and
  `identity_keys`, and that a transaction **without** the `SET LOCAL`s reads zero
  rows from every RLS-protected table.
- `internal/store/channel_purge_test.go` — sweep an ephemeral channel with a
  guest, assert **zero** surviving rows in `messages`, `attachments`,
  `channel_members`, `channel_keys`, `ephemeral_*`, `users`.
- `internal/server/guest_fence_test.go` — table-driven over every route and every
  frame constant; a new frame with no allowlist entry must fail.
- `internal/auth/join_http_test.go` — expired 410, replayed challenge refused,
  wrong-key signature refused, unknown lookup indistinguishable from known.
- `web/src/crypto/guest-link.test.ts` — same secret → same keypair; a
  creator-made wrap opens with the guest-derived key.
- `web/src/chat/countdown.test.ts` — formatting and boundaries.

End-to-end with the `run-chalk` skill: create an ephemeral channel, mint a link,
open it in a second browser context, pick a name, join the call, type in the
scratchpad both ways. Then exercise the operator path — `chalkctl ephemeral list`,
`purge --channel`, `disable` — and confirm the room and the guest are gone from
both clients and from Postgres.

## Out of scope

Guests in normal channels; guest attachments, threads or reactions; more than one
device per guest; recovering an ephemeral channel after expiry.

## Adjacent things this surfaced (not phase 80)

- `store.PurgeUser`'s doc comment (`internal/store/admin.go:311`) claims
  `messages.sender_id` is set NULL. There is no such column — it is
  `sender_device_id → devices` (migration 0009). Do not reason from that comment,
  and keep the janitor out of `PurgeUser`, which also blacklists the purged email.
- `PurgeVoiceScratchIfEmpty` already fires at every lull, so a guest returning
  from a break sees an empty room. Existing behaviour; the UI should say so.
- `store.RemoveMember` sets `rotation_pending`, sprouting a key-rotation warning
  for a room about to be deleted. Let expiry remove guests, not `RemoveMember`.
- Two people sharing one link derive the same identity and collide on
  `voice_participants`' PK — correct failure, terrible message. Surface it as
  "this link is already in use".
- `docker/Dockerfile` ships unminified bundles (an open item in
  `docs/open-items.md`). A guest lands cold with no cache, so this phase makes
  that user-visible for the first time.

## As built (deviations from the plan above)

Recorded during implementation; each was a deliberate call, not drift.

- **`chalk_app` is a non-superuser MEMBER of `chalk`** (`GRANT chalk TO
  chalk_app`), not a role with enumerated grants. chalkd does runtime DDL
  (the daily partition-maintenance loop) and boot-time migrations, both of
  which need owner rights; membership provides them while SUPERUSER — an
  attribute, never inherited — is gone from the session. One `CHALK_DB_URL`
  for chalkd, no separate migrate URL. The security boundary is unchanged:
  `chalk_guest` has no membership.
- **Guest voice-occupancy frames reuse the app handlers** (join/leave/roster/
  state/signal) instead of running under `chalk_guest`: locking reads
  (`SELECT ... FOR UPDATE`) require UPDATE-policy rows, which the fence
  deliberately fails closed on, and the join/purge channel-row lock must be
  one lock. Those handlers take only server-derived parameters and are
  membership-checked; everything guest-typed (messages, reads, identity/key
  fetches, listing) runs under `chalk_guest` via `store.Guest`.
- **The guest client is a separate tree** (`/join` mounts JoinScreen/GuestRoom
  from index.tsx), not the App in a guest mode — it reuses WSClient,
  spacekey and VoiceCall directly. The App's session/identity boot never
  runs for guests.
- **`chalkctl ephemeral purge` expires rather than deletes**: it revokes the
  room's links and sets `expires_at = now()`; chalkd's minutely janitor
  performs the hard delete. One deletion path, one audit trail, and the
  80-14 push + guest kick come for free.
- Guest sessions use their own cookie (`chalk_guest_session`, SameSite=Lax
  per the open decision) so a member clicking a join link keeps their real
  session. The REST allowlist for guests is `/ws` only.
- `CHALK_TRUSTED_PROXY` (the owed decision) landed as a CIDR list or the
  value `private`; when the peer matches, the LAST X-Forwarded-For entry
  wins.
- The shared-table fence additionally covers `channel_activity` and
  `voice_signal_spool`, which the plan's grant list missed but the real
  query paths need; the `users` column grant includes `handle` (name
  resolution selects it), with guests' display names substituted at the
  `HandlesByID` chokepoint.
- Ephemeral env knobs carry explicit units: `CHALK_EPHEMERAL_MAX_TTL_HOURS`,
  `CHALK_EPHEMERAL_INVITE_MAX_TTL_HOURS`.
- The join challenge carries a nonce (`nonce || ts || HMAC`), found by test:
  deterministic per-second challenges collided with the replay set when two
  redemptions raced in the same second.

# Phase 88 — federation: talking to other chalk servers

Whether a chalk deployment can join up with another one, and whether a single
client can hold several at once. Designed against v0.7.3. **NOT IMPLEMENTED —
and for the server-to-server half, deliberately not going to be.** This
document is the record of that decision and the reasoning behind it.

**Status:** design only — considered and declined, written 5 August 2026 from a
design session. Unlike phases 65, 86 and 87, this is not a plan waiting for a
builder; it is a design that was examined and turned down. The conditions that
would reopen it are named at the end.
**Tag:** `#federation` → `tools/where.sh -g federation` (which today finds this
file and the threat model, because there is no code and there is not going to
be any).

## Why write this down at all

`docs/threat-model.md` has listed "Federation (server-to-server, à la Matrix)"
under **Out of scope** since the file was written, as a bare bullet with no
reasoning attached. That is not enough. A one-line "no" invites the question
again every time somebody reads the file, and — worse — it hides the fact that
one of the two things people mean by the question is largely solved already.

So this document exists to do two things the bullet cannot: give the refusal
its argument, and record what *does* work today, so nobody rediscovers it from
scratch.

## The question has two readings

They are usually asked in the same breath and they have almost nothing in
common.

- **Reading A — one client, several servers.** Like an IRC client holding
  several networks: one app, one window, N independent chalk deployments, no
  channel spanning any two of them. Nothing about the servers changes; they
  never learn about each other.
- **Reading B — server-to-server federation.** A channel whose members live on
  two different chalk deployments, with the servers relaying on each other's
  behalf. This is what Matrix means by the word.

Most of the *value* people are after is in A. Almost all of the *cost*, and all
of the danger, is in B.

## Reading A — one client, several servers

### What already works, with no code at all

**One browser tab per server.** Cookies, IndexedDB, `localStorage`, the
notification permission and the installed PWA are all scoped per origin, so two
chalk instances open in two tabs are already cleanly and completely isolated
from each other. Nothing leaks between them; nothing needs building. If the
requirement is "I am in two chalk communities and I want both open", that is
the answer, and it is available now.

The PWA manifest makes this explicit rather than accidental: `web/manifest.json`
has `"id": "/"` and `"scope": "/"`, so each server installs as its own app.

### Identity is already portable, which is worth stating out loud

`web/src/crypto/identity.ts` derives the X25519 and Ed25519 keys from the
24-word phrase through HKDF with fixed salt and info strings and **no server
input whatsoever**. The consequence is a genuinely useful property that exists
today by construction:

> The same recovery phrase makes you the same keyholder on every chalk
> instance. Your Ed25519 identity key on server A and on server B are the same
> key.

Which means `computeSafetyNumber` in `web/src/crypto/safety-number.ts` — the
picture-word comparison from phase 24 — is meaningful *across* deployments. If
you have compared safety numbers with someone on one chalk server, that
comparison is about the person, not about the account, and it holds anywhere
else you both turn up.

This was never designed as a federation feature; it falls out of deriving
identity client-side from a phrase. But it is real, it is the part of
"federated identity" that actually matters, and it should not be rediscovered
by accident a third time.

What is *not* portable is the account: `users.id` is a server-minted UUID, so
the same person is a different `user_id` on each deployment, and the TOFU pins
in the `verifications` store are keyed by bare `peerUserID`. Per-origin
IndexedDB keeps that from being a problem for tab-per-server. It becomes one
the moment anybody tries to unify — see below.

### What a single unified client would need

Ordered by how immovable each item is, because the top two decide the answer
and the rest is only work.

1. **Auth is the wall.** `chalk_session` is `HttpOnly` + `SameSite=Strict` and
   per-origin (`internal/auth/sessions.go:35`, set at `:107-117`). Server B's
   cookie cannot be sent from origin A, and `HttpOnly` means script cannot read
   or forward it. There is no token path anywhere in the client to fall back on
   — no `Authorization` header, no stored bearer token; `web/src/auth/api.ts:14`
   states the same-origin invariant deliberately. And there is **no CORS
   handling in the Go server at all** (`Access-Control` appears nowhere under
   `internal/`). On top of that the WS upgrade at `internal/server/ws.go:181`
   passes only `Subprotocols` to `websocket.Accept`, so coder/websocket's
   default same-origin check applies and a cross-origin socket is refused
   server-side too.

   Passkeys are worse than merely unported: WebAuthn binds a credential to the
   RP (`internal/auth/service.go:20`, origins at `:37`), so a passkey
   registered against server A is unusable against B *by design*. No amount of
   chalk-side work changes that.

2. **`connect-src 'self'`** (`internal/server/spa.go:109`) stops a second
   origin in the browser before any of the above gets a chance to matter. That
   directive is load-bearing, not incidental: the comment at `spa.go:70-78`
   names it as the one that matters and notes it covers the WebSocket upgrade
   too, and `spa_test.go:209` pins it. Relaxing it to a user-configured
   allowlist gives up the property phase 51-1 bought — that a compromised
   dependency in the bundle can only talk to us.

3. **IndexedDB has no server dimension.** `DB_NAME = "chalk"`
   (`web/src/crypto/idb.ts:34`) is a constant, and the key formats carry only
   chalk-side ids: identities by bare `userID`, verifications by bare
   `peerUserID`, space keys by `channelID:keyVersion`, attachments by
   `attachmentID:keyVersion:variant`. Two servers' UUIDs would collide in one
   namespace. Note before re-keying: `channelHasSignedKey` does a primary-key
   prefix range scan justified by a channel id containing no `:`, so any
   server-prefixed scheme has to preserve that invariant or bump `DB_VERSION`.
   `localStorage` is flat the same way (`chalk.deviceId`, `chalk.notify.v2`,
   `chalk.mic.v1`, …) — with one instructive exception, `GuestRoom.tsx:77`'s
   `"chalk_guest_device:" + guestUserID`, which is already namespaced and shows
   the shape the rest would take.

4. **~18 module-level singletons** that each implicitly mean "the one server":
   chiefly `voiceSession` (`web/src/voice/session.ts:839`), `typingStore`
   (`web/src/chat/typing-store.ts:136`), the title controller
   (`web/src/notify/title.ts:89`) and the notification banners
   (`web/src/notify/banners.ts:217`), plus the listener-set prefs stores. Some
   of these are singletons for a good reason — a browser tab has one
   `document.title`, and being in two calls at once is not obviously wanted —
   so this is a design question, not only a refactor.

5. **Two hard-coded origins and 51 relative fetches.** The WS URL is built from
   `window.location` at `web/src/components/App.tsx:1791` and again at
   `GuestRoom.tsx:152`; there are 51 root-relative `fetch("/api/...")` call
   sites across 13 files and no API-base constant or build-time define. Largest
   diff by line count, smallest by difficulty.

6. **Routing and the single mount.** One URL bar, one `state.route`, one
   `#root` — `web/src/index.tsx:24` branches on pathname to render either
   `JoinScreen` or `App`. A server dimension would have to appear in the route.

### The encouraging half

The parts that would normally make this an architectural rewrite are already in
good shape, and this deserves recording so it is not re-derived:

- **State is not a global.** `useReducer(reducer, initialState)` lives inside
  `App` (`App.tsx:469`) — no Preact context, no signals, no module store. Two
  `<App/>` instances would already have two independent states.
- **Components are already parameterized.** All 50 components under
  `web/src/components/` take identity as props (`selfUserID`, `selfDeviceID`);
  `state.user` is touched in exactly two files, `App.tsx` and
  `state/reducer.ts`.
- **The socket is already an instance.** `WSClient` takes `url` as an option
  (`web/src/ws-client.ts:33`) and is held in a ref (`App.tsx:470`), not
  imported by components. `GuestRoom` already runs a second `WSClient` in a
  separate Preact tree in the same page, so multi-socket is not hypothetical.

The client is not the obstacle. **The origin is.**

### Conclusion for reading A

Every immovable blocker above — cookie scoping, CORS, CSP, WebAuthn RP ID — is
a constraint of being a same-origin *web app*, not a flaw in how chalk is
built. Fighting them from inside the browser means giving up `connect-src
'self'` and inventing a second auth mechanism, which is a large amount of new
security surface bought for a convenience feature.

Two ways out, both better than that fight:

- **Tab per server.** Works today, costs nothing, and is what should be
  recommended to anyone who asks.
- **A desktop shell**, if a unified client is ever genuinely wanted. It
  sidesteps cookie scoping, CSP and origin checks entirely, and reduces the job
  to items 3–6 above, which are ordinary work. That is a separate project from
  the chalk server and should never be smuggled in as a phase against it.

Reading A therefore does not need a phase.

## Reading B — server-to-server federation

### The objection is trust, not effort

Effort arguments age; this one does not.

chalk today trusts the server for **sender attribution** and **channel
membership**. Both are stated as unmet guarantees in `docs/threat-model.md`,
and both are the subject of the unstarted phase 83. Federation does not change
that trust — it multiplies it across N servers, and the additional ones are
servers you do not run and cannot inspect.

The mechanism is concrete rather than theoretical. `rewrapForMissing` in
`web/src/crypto/channel-crypto.ts` auto-reshares the channel key to every
member the roster names who lacks a wrap. The roster is server-asserted. Point
part of it at a remote deployment and **a legitimate member's own client hands
the channel key to whoever the remote server claims is a member.** 82-8's join
notice makes that visible after the fact; nothing in the current design can
prevent it.

Signing a wrap, which phase 82 bought, proves who *sent* a key. It says nothing
about who *deserved* one. Federation is precisely the case where that gap stops
being academic, because the party asserting desert is a stranger.

### Phase 83 is a prerequisite, not a predecessor

The distinction matters. A predecessor is something you would rather have
first; a prerequisite is something without which the work is
counterproductive. Federating before the signed message envelope and the
authenticated channel-state transcript would **strictly worsen** chalk's
security model rather than merely stretch it: today there is one server to
trust and the operator is you, and afterwards there would be several, most of
them not you, with the same unauthenticated membership and sender metadata
underneath.

Anything that federates has to be able to answer "who says this person is in
this channel?" without the answer being "a server said so". That is phase 83's
job, and it has to be finished and load-bearing before this question is worth
asking again.

### The scale, for calibration

Even granting phase 83, the size of the remaining job is routinely
underestimated, because people picture federating *messages*.

`internal/proto/` defines **112 frame types** (8 in `proto.go`, 74 in
`frames.go`, 13 in `voice.go`, 11 in `governance.go`, 6 in `ephemeral.go`);
`web/src/proto.ts` mirrors 96 of them. Behind those: presence is durable,
per-device and server-authoritative with its own janitor and demotion sweeps;
typing is fire-and-forget over `pg_notify` with no persistence; read cursors
are durable and deliberately fan out only to the *same* user's other
connections; voice is a mesh whose TURN credentials are minted by the server
that owns the room; governance is a voting system; attachments are a
member-checked partitioned blob store.

Each of those needs a cross-server semantic of its own, and several have no
obvious one. What does presence mean when the authoritative instance is not
yours? Who mints TURN credentials for a call spanning two deployments? Federation
is not one protocol — it is a distinct design decision per subsystem, most of
which would be answered by giving up a property chalk currently has.

### One thing that already points the right way

Worth recording so it is not rediscovered: migration `0050_ephemeral.sql`
solved the "principal who is not a normal account" problem **without** a second
principal table. A guest gets a real `users` row with `role='guest'` and
`guest_channel_id` set, confined by a separate Postgres role `chalk_guest` plus
FORCE row-level-security policies keyed on `SET LOCAL chalk.guest_user`.

That is the shape a remote user would take — `role='remote'` plus a home-server
column — and it fits the existing FK graph, where nearly everything hangs off
`users(id) ON DELETE CASCADE`. So the schema is not what makes federation hard.
The trust model is. Recording this is meant to save the next person the two
hours it takes to conclude that the easy part is easy.

## Decision

**Server-to-server federation stays out of scope.** Not "not yet, we are busy"
— declined, on the grounds that it would multiply a trust dependency chalk has
not yet discharged.

**Reading A gets no phase either**, for the opposite reason: the useful part
already works. Tab-per-server is the supported answer, portable identity across
instances is a property that already holds, and a unified multi-server client
is a desktop-shell project rather than something the chalk server can grant.

## What would reopen this

Both conditions, not either:

1. **Phase 83 has shipped** — signed message envelopes *and* the authenticated
   channel-state transcript — so membership and sender attribution no longer
   rest on a server's word.
2. Somebody actually wants a channel spanning two deployments badly enough to
   design N-server trust, subsystem by subsystem, with the presence/voice/
   governance questions above answered rather than deferred.

Until then, the answer to "can chalk federate?" is: *your identity already
does; the server does not, and that is deliberate.*

## Not being built

Stated explicitly so this document cannot be mistaken for a backlog item. No
server-to-server protocol. No remote principals or shadow user rows. No CORS.
No bearer-token auth path. No relaxation of `connect-src`. No IndexedDB
re-keying. No new frame types, no migration, and no `// 88-n:` phase comments
anywhere in the source — which is why this topic's line in `docs/tags.md`
carries `-` in its phase column.

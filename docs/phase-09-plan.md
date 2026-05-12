# Phase 09 — Plan

**Status**: planning, not yet started.
**Scope**: replace the device-ensure shim with real auth; introduce passkeys, usernames, recovery codes; rewrite the hub connection model to support multiple concurrent connections per user.

This document is the spec phase 09 implementation should follow. Decisions are marked **DECISION**; open questions are marked **OPEN**.

## Goals

1. Get rid of `ensureDeviceForTesting` and the hard-coded alice/bob/carol UUIDs in the welcome flow. Real users must register and log in.
2. Authentication is passkey-based (WebAuthn). No passwords. Recovery via 24-word codes (BIP-39 wordlist).
3. A user can have multiple concurrent connections (multiple tabs, multiple devices) without one evicting the other.
4. Existing migrations and the SPA continue to work for the dev fixtures; alice/bob/carol get bootstrap passkeys via a dev-only path.
5. The MLS work in phase 10 will assume `(user_id, device_id, identity_key)` is a stable triple — phase 09 establishes that contract.

## Non-goals (deferred)

- Multi-factor beyond passkey + recovery code
- Email/phone account recovery
- Social login / OAuth
- Username changes (we'll allow handle changes, but username is immutable once chosen)
- Cross-device passkey sync UI (we rely on platform-native sync, e.g. iCloud Keychain)

## What changes for the user

**Today (phase 08c)**:
- Open browser → SPA generates a random `deviceId` and writes it to localStorage
- SPA opens WebSocket, sends `hello{device_id}`
- Server's `ensureDeviceForTesting` hard-maps the deviceId to alice's user row
- User is "alice" forever, regardless of who's actually at the keyboard

**After phase 09**:
- Open browser for the first time → SPA shows a registration screen (pick a username, register a passkey, save recovery codes)
- Subsequent opens → SPA shows a "log in with passkey" button, browser prompts for passkey, SPA sends `authenticate` frame, server validates, returns session token
- SPA opens WebSocket, sends `hello{session_token, device_id}`
- Server validates the session token, maps to user_id, generates a fresh device_id if needed, returns `welcome{user_id, device_id, handle, username, channels}`

Sessions are server-side; the SPA holds a short-lived token (cookie or localStorage) and refreshes via passkey when expired.

## Decisions

### DECISION 1: usernames vs handles

We have two display-name-shaped things in the schema. We need to decide their roles:

- **username**: chosen at registration, immutable, globally unique, used for login (`@alice` in the login screen). Also the default value of `handle`.
- **handle**: mutable display name, shown in DM labels and status badges (`you (alice)`, `@bob DM`). Defaults to `username`; user can change it without affecting login.

This is the same shape Mastodon uses (`@user@instance` for login, display name separately). Keeps the password-equivalent stable while letting users rename themselves cosmetically.

**Schema change**: add `username CITEXT UNIQUE NOT NULL` to `users`. Backfill from `handle` for existing rows. Add `CHECK (username ~ '^[a-z0-9_]{3,32}$')` for sensible login UX.

**Wire change**: `WelcomePayload` gains a `username` field alongside `handle`. SPA stores both; UI uses `handle` everywhere except the auth screen and the "you are logged in as" affordance.

### DECISION 2: WebAuthn library

Use [`github.com/go-webauthn/webauthn`](https://github.com/go-webauthn/webauthn). It's the maintained successor to `duo-labs/webauthn`, with active releases through 2025, MIT licensed, no external deps beyond the standard library + crypto helpers.

Wrap it behind a small `internal/auth` package so we can swap it later if needed. The wrapper exposes:

```go
type AuthService interface {
    BeginRegistration(ctx, user) (challenge, sessionData, error)
    FinishRegistration(ctx, user, sessionData, response) (credential, error)
    BeginAuthentication(ctx, username) (challenge, sessionData, error)
    FinishAuthentication(ctx, username, sessionData, response) (credential, error)
}
```

Library specifics (`*webauthn.WebAuthn`, `*protocol.CredentialAssertion`, etc.) stay inside `internal/auth`.

### DECISION 3: session model

**Decision**: opaque server-side session tokens, stored in a `sessions` table, returned via Set-Cookie (HttpOnly, Secure, SameSite=Strict).

Why not JWT: we want revocation on logout, on password-equivalent change, on suspicious activity. JWT revocation is awkward. The server is already stateful (Postgres), so opaque tokens are cheaper than the JWT round-trip and trivially revocable.

**Schema**:
```sql
CREATE TABLE sessions (
  token         BYTEA       PRIMARY KEY,            -- 32 random bytes
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  user_agent    TEXT,                                -- best-effort, for the "active sessions" UI
  ip_address    INET                                 -- best-effort, for the same
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);
```

**Token shape on the wire**: hex-encoded `chalk_sess_<64chars>` in the cookie value. The hex prefix makes leaks grep-able.

**TTL**: 30 days sliding window. `last_used_at` updated on each WebSocket handshake. Cron-style cleanup of expired sessions runs in the janitor.

**OPEN**: do we support multiple concurrent sessions per user (one per device)? Yes — already supported by the schema; the UI just needs an "active sessions" list and a revoke button. Build the schema for it; defer the UI.

### DECISION 4: recovery codes

24 words from the BIP-39 English wordlist (2048 words → 264 bits of entropy at 11 bits/word; we use 256 of those). Shown to the user once at registration. Hashed (argon2id) and stored in `recovery_codes`.

**Schema**:
```sql
CREATE TABLE recovery_codes (
  user_id    UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hash       BYTEA       NOT NULL,         -- argon2id of the 24-word phrase
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at    TIMESTAMPTZ                   -- non-null once consumed
);
```

One code per user. Using it issues a new session AND invalidates the code; user must generate a fresh one immediately or accept the warning.

Recovery flow:
1. SPA prompts for username + 24 words
2. Server looks up recovery_codes row, argon2id-verifies the phrase
3. On success: marks `used_at`, returns session token + warns "generate a new code"
4. SPA shows the regenerate-recovery-code screen
5. New code overwrites the old row (replaces hash, clears used_at)

**OPEN**: should we allow N>1 unused codes per user (a code "pool")? Simpler model is N=1. Defer the pool idea unless we hit a real use case.

### DECISION 5: passkey + credential schema

```sql
CREATE TABLE passkeys (
  credential_id    BYTEA       PRIMARY KEY,      -- WebAuthn credential ID
  user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key       BYTEA       NOT NULL,         -- CBOR-encoded COSE key
  sign_count       BIGINT      NOT NULL DEFAULT 0,
  transports       TEXT[]      NOT NULL DEFAULT '{}',  -- ['usb','ble','nfc','internal',...]
  name             TEXT,                          -- user-chosen label, "my iPhone"
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at     TIMESTAMPTZ
);
CREATE INDEX passkeys_user_idx ON passkeys(user_id);
```

Users can register multiple passkeys (their phone, their laptop, a hardware key). Each can be revoked independently.

`sign_count` matters: WebAuthn requires the server to track the credential's increment counter to detect cloned authenticators. The go-webauthn library handles this; we just have to persist it after each auth.

### DECISION 6: connection model rewrite

The current hub:
```go
type Hub struct {
    conns sync.Map // map[deviceID]*Conn  -- "new wins" eviction
}
```

is replaced with:
```go
type Hub struct {
    byUser   sync.Map // map[userID]*userConnSet
    byConnID sync.Map // map[connID]*Conn  -- for direct lookup
}

type userConnSet struct {
    mu    sync.Mutex
    conns map[connID]*Conn
}
```

**Key changes**:
- Each connection gets a fresh `connID` (UUID generated server-side at handshake). The browser still has a stable `deviceID`, but `deviceID` is no longer the routing key.
- Fanning out a message to a user means iterating `userConnSet.conns` and sending to each.
- Disconnecting a session evicts all of that session's conns. Disconnecting a single tab leaves the other tabs alone.
- The echo-suppression rule changes from "don't send to the sending device" to "don't send to the sending conn" — important if the user has the same device with two tabs and sends from tab A, tab B should still get the echo via the same device.

**OPEN**: actually, do we want tab B to get the echo? The current rule was about avoiding the SPA showing duplicate "you" messages because it already optimistically appended. With multi-tab, tab A appends optimistically, tab B sees nothing because the server suppresses. Tab B then has stale state until reload.

**DECISION (revisable)**: echo-suppress per *conn*, not per device. Tab B gets the message via the normal fan-out path. Tab A's optimistic-append is the only way it sees its own send. Tab B never optimistic-appends what it didn't send.

This is a subtle correctness improvement and the right time to make it.

### DECISION 7: device row lifecycle

Today: device rows are created on first hello via `ensureDeviceForTesting`, hard-tied to alice.

Tomorrow:
- Registration creates the **first** device row alongside the user row, tying the passkey to that device.
- Subsequent logins on a new browser create new device rows (with a UI prompt: "name this device").
- Device rows persist; deleting a device cascades to its passkeys and presence rows.
- `device_id` returned in `welcome` is now a real, persisted thing per browser per user.

**Schema additions to `devices`**:
- `passkey_credential_id BYTEA NULL REFERENCES passkeys(credential_id) ON DELETE SET NULL` — the passkey used to enroll this device. Null for legacy/dev rows.
- `name TEXT` — already exists as `device_label`, rename to `name` for consistency. (Or leave it. Cosmetic.)

**OPEN**: how do existing fixture devices (alice/bob/carol with deterministic UUIDs) get passkeys? See "Dev fixtures" below.

## Wire protocol changes

### New frame types

```
register_begin       client → server     { username, display_name? }
register_begin_ack   server → client     { challenge, rp, user_id, options }    // WebAuthn create options
register_finish      client → server     { credential_response }                 // AttestationResponse
register_finish_ack  server → client     { session_token, recovery_words[24], user_id, username, handle }

authenticate_begin     client → server   { username }
authenticate_begin_ack server → client   { challenge, allow_credentials, options }   // WebAuthn get options
authenticate_finish    client → server   { credential_response }                     // AssertionResponse
authenticate_finish_ack server → client  { session_token, user_id, username, handle }

recovery_begin       client → server     { username }
recovery_finish      client → server     { username, words[24] }
recovery_finish_ack  server → client     { session_token, user_id, regenerate_required: true }

logout               client → server     {}                                      // current session
logout_ack           server → client     {}

list_passkeys        client → server     {}
list_passkeys_ack    server → client     { passkeys: [{credential_id_hex, name, created_at, last_used_at}] }

revoke_passkey       client → server     { credential_id_hex }
revoke_passkey_ack   server → client     { credential_id_hex }
```

### Modified frame types

```
hello (phase 04)
  before: { device_id }
  after:  { session_token, device_id? }   // device_id optional; server mints one if absent

welcome
  before: { user_id, device_id, handle, channels }
  after:  { user_id, device_id, username, handle, channels, session_expires_at }
```

### HTTP endpoints (alongside WebSocket)

WebAuthn registration/auth ceremonies want HTTPS, not WebSocket. The challenge-response flow is request/response shaped, so HTTPS fits better. WebSocket carries only `hello` + the post-auth frames.

```
POST /api/auth/register/begin       { username, display_name? }     → { challenge, options, sessionData }
POST /api/auth/register/finish      { sessionData, response }       → { session_token, recovery_words[24] }
POST /api/auth/authenticate/begin   { username }                    → { challenge, options, sessionData }
POST /api/auth/authenticate/finish  { sessionData, response }       → { session_token }
POST /api/auth/recovery             { username, words[24] }         → { session_token, regenerate_required }
POST /api/auth/logout                                                → 204
GET  /api/auth/me                                                    → { user_id, username, handle, session_expires_at }
```

`session_token` is set via Set-Cookie (HttpOnly). The SPA never sees the raw token. It calls `/api/auth/me` to know who it is, then opens the WebSocket which automatically sends the cookie.

**Rationale for splitting HTTP and WebSocket**: WebAuthn's flow is naturally request-response. Putting it in WebSocket frames means inventing correlation IDs for what HTTP gives us for free. The WebSocket is for streaming chat; HTTP is for transactions.

## Schema migrations

```
migrations/0011_usernames.sql      — add users.username; backfill from handle
migrations/0012_passkeys.sql       — passkeys table
migrations/0013_sessions.sql       — sessions table
migrations/0014_recovery_codes.sql — recovery_codes table
migrations/0015_devices_link.sql   — devices.passkey_credential_id
```

Five migrations, all additive. No destructive changes. Existing dev fixtures (alice/bob/carol with UUIDs) keep working; they just get usernames backfilled and no passkeys until we add them via the dev path.

## Dev fixtures

The `bootstrap/fixtures/users.sql` and `tools/dev.sh` flows install alice/bob/carol deterministically. After phase 09, they need passkeys too — but passkeys are tied to specific authenticators on specific devices, so we can't just `INSERT INTO passkeys` with hardcoded values.

**Plan**: add a dev-only HTTP endpoint `POST /api/dev/bootstrap-passkey` (guarded by `CHALK_DEV=1` env var) that lets the dev seed script register a software-authenticator passkey for alice/bob/carol via the standard WebAuthn flow but with a known-static key. The dev SPA gets a "log in as alice/bob/carol" dev shortcut button when `CHALK_DEV=1`.

Production builds compile out the dev path entirely (`go:build dev` or runtime env check + a hard error if accessed).

**OPEN**: do we actually need passkeys for fixture users, or can dev mode bypass auth entirely? Probably the latter is simpler for `make dev`: a dev-only login endpoint that takes `?as=alice` and issues a session token without any passkey check. Decided: yes, that's cleaner. Keep the real passkey path testable separately via integration tests.

## SPA changes

### New components

- `web/src/components/auth/RegisterScreen.tsx` — username picker, calls `register_begin` → triggers `navigator.credentials.create()` → calls `register_finish` → shows recovery words → goes to chat
- `web/src/components/auth/LoginScreen.tsx` — username field, "log in with passkey" button → `navigator.credentials.get()` → chat
- `web/src/components/auth/RecoveryScreen.tsx` — 24 word input, validates locally, calls `/api/auth/recovery`, prompts for new passkey
- `web/src/components/auth/RecoveryWordsDisplay.tsx` — shown once at registration; copy-to-clipboard, download-as-text, "I saved these" confirmation gate

### State changes

`AppState.user` gains `username`, `session_expires_at`. New top-level state `authStage: "register" | "login" | "recovery" | "authed"`. The existing chat UI only renders when `authStage === "authed"`.

### Storage

- Session cookie: HttpOnly, set by server, SPA never reads
- Recovery words: never stored; user copies/downloads at registration time and that's the only chance
- Username: cached in localStorage for the "remember username" UX (only the username, never the token)
- Device label: cached in localStorage so re-registration doesn't keep prompting

## Server changes

### New packages

```
internal/auth/
  service.go         — AuthService interface + wrapper around go-webauthn
  registration.go    — Begin/FinishRegistration
  authentication.go  — Begin/FinishAuthentication
  session.go         — token mint, validate, refresh, revoke
  recovery.go        — 24-word generation, argon2id hash/verify
  middleware.go      — http.Handler middleware that requires a valid session
```

### Modified packages

```
internal/server/
  ws.go              — hello reads session_token from cookie; deletes ensureDeviceForTesting
  hub.go             — connection model rewrite (see DECISION 6)
  http_auth.go       — new file with the /api/auth/* handlers
  http.go            — wire up the new HTTP routes

internal/store/
  users.go           — add Username field to User; GetUserByUsername; UpdateUsername (immutable; only used by registration)
  sessions.go        — new file with session CRUD
  passkeys.go        — new file with passkey CRUD
  recovery.go        — new file with recovery code CRUD
  devices.go         — Add LinkPasskey, ListDevicesForUser already exists
```

### Hub rewrite implementation outline

```go
func (h *Hub) Register(c *Conn) {
    h.byConnID.Store(c.ID, c)
    setI, _ := h.byUser.LoadOrStore(c.UserID, &userConnSet{conns: map[string]*Conn{}})
    set := setI.(*userConnSet)
    set.mu.Lock()
    set.conns[c.ID] = c
    set.mu.Unlock()
}

func (h *Hub) Unregister(c *Conn) {
    h.byConnID.Delete(c.ID)
    if setI, ok := h.byUser.Load(c.UserID); ok {
        set := setI.(*userConnSet)
        set.mu.Lock()
        delete(set.conns, c.ID)
        empty := len(set.conns) == 0
        set.mu.Unlock()
        if empty {
            h.byUser.Delete(c.UserID)
        }
    }
}

func (h *Hub) FanOut(userID string, payload []byte, exceptConnID string) {
    setI, ok := h.byUser.Load(userID)
    if !ok { return }
    set := setI.(*userConnSet)
    set.mu.Lock()
    targets := make([]*Conn, 0, len(set.conns))
    for id, c := range set.conns {
        if id != exceptConnID {
            targets = append(targets, c)
        }
    }
    set.mu.Unlock()
    for _, c := range targets {
        c.Send <- payload  // non-blocking via select-default in real code
    }
}
```

(The real implementation needs careful lock ordering and the Send channel needs a default-drop to prevent slow consumers blocking the fan-out. Spec it carefully when writing.)

## Test plan

### Unit tests

```
internal/auth/
  registration_test.go    — happy path, duplicate username, malformed credential
  authentication_test.go  — happy path, unknown user, wrong credential, sign_count rollback detection
  session_test.go         — mint, validate, refresh expiry, revoke
  recovery_test.go        — 24-word gen entropy, hash/verify, one-shot use enforcement

internal/server/
  hub_phase09_test.go     — multi-conn-per-user, fanout-except-self-conn, eviction-on-disconnect-doesn't-cascade
```

### Integration tests

```
test/integration/
  auth_test.go            — full registration round-trip, full authentication round-trip
  session_test.go         — session expiry, refresh on use
  recovery_test.go        — recovery → regenerate flow
  multi_conn_test.go      — same user, two ws connections, both receive a message sent to either
```

### E2E tests

```
test/e2e/
  auth.spec.ts            — register a new account, log out, log back in
  recovery.spec.ts        — use recovery code, verify new passkey works
  multi_tab.spec.ts       — open two tabs as same user, send from tab A, see in tab B
```

The auth e2e tests need a virtual authenticator. Playwright supports this via `page.context().addInitScript()` injecting a mock; `go-webauthn` accepts our software-authenticator key in dev mode.

## Rollout / migration story

This is greenfield for a personal project, but in principle:

1. Deploy 09 server alongside 08c clients — server accepts both old hello (with `device_id` only, falling back to `ensureDeviceForTesting` for legacy) and new hello (with `session_token`)
2. Ship new SPA — auth screens, registration flow, switches to session-token hello
3. Sunset the legacy path — remove `ensureDeviceForTesting`, require session_token in hello

For chalk specifically, we'll do all three at once and reset the dev DB. The transition story is documented for posterity, not because we'll actually need it.

## Estimated cycles

Phase 08 took 10 fix cycles for ~8000 lines across 30+ files. Phase 09 is a similar size but more isolated:

- ~5 new server-side packages (auth, sessions, passkeys, recovery, http)
- ~5 new migrations
- ~3 new SPA screens
- 1 connection-model rewrite (hub.go)

**Estimated**: 12-15 fix cycles spread across maybe 5-7 sub-phases. The hub rewrite alone is its own sub-phase (let's call it 09a). Auth is 09b. Recovery + passkey management is 09c.

**Recommend splitting**:
- 09a: hub rewrite (userID-keyed, multi-conn, no auth changes)
- 09b: schema + auth service + HTTP auth endpoints + SPA register/login screens
- 09c: recovery flow + active sessions UI + passkey management

09a is independent and can ship immediately; it fixes the duplicate-tab bug. 09b is the big one. 09c is polish.

## Open questions (no decision yet)

1. **Cookie domain / SameSite**. SameSite=Strict means a passkey login from a different origin wouldn't carry the cookie back. For chalk (single-origin) this is fine. Confirm before shipping.

2. **Rate limiting on auth endpoints**. Per-IP and per-username? Phase 13 is "hardening" but maybe a minimal rate limit on `/api/auth/*` should ship in 09 to avoid being the chalk-easy account-stuffing target. Probably yes; spec a simple in-memory limiter.

3. **Username vs handle for status badge**. Today it shows `you (alice)`. Post-09 with both fields, do we show `you (alice)` (handle) or `you (@alice)` (username)? My instinct: handle, with username only on auth/settings screens. Decide before SPA work.

4. **Account deletion side-effects in phase 11**. Phase 11 was going to add the lifecycle write paths (deactivate/delete/reactivate). With phase 09 introducing sessions and passkeys, the delete cascade has more to clean up. Make sure phase 11's plan covers cascading to sessions, passkeys, recovery codes.

5. **Multi-passkey UX**. Should the SPA prompt to register a second passkey ("backup device") right after registration? Many sites do this. It's a soft prompt, easy to dismiss. Probably yes; build the UI but make it skippable.

6. **WebAuthn user verification (UV) requirement**. PIN/biometric required, or "preferred"? "Required" is more secure but breaks on hardware keys without UV. "Preferred" is the standard. Go with "preferred".

7. **Logout-everywhere button**. "Sign out of all sessions" is standard. Trivial to implement (`DELETE FROM sessions WHERE user_id = $1`). Include in 09c.

## Things explicitly out of scope (write them down so we don't forget)

- Email recovery (would require email infrastructure; out of scope)
- Phone number / SMS (out of scope, and SMS is a bad recovery channel anyway)
- Social login (Google/Apple/etc) — out of scope; conflicts with the no-server-trust model
- Encrypted username (the username is server-visible by necessity; that's a tradeoff)
- Username search / discovery — out of scope; you already need to know someone's username to friend them
- Passwordless email login codes — out of scope; passkeys are the auth method

## Open prep work (no code, useful before starting)

- Read RFC 9420 (MLS) sections that touch device identity, since phase 10 will assume the `(user_id, device_id, identity_key)` triple from phase 09
- Read [go-webauthn's docs](https://pkg.go.dev/github.com/go-webauthn/webauthn) and build a 30-line throwaway registration POC outside the chalk repo
- Read [SimpleWebAuthn's browser library docs](https://simplewebauthn.dev/docs/packages/browser) — that's the easiest client wrapper, smaller than rolling our own
- Decide on UV preference, cookie SameSite, and the multi-passkey UX questions above

When all the OPEN questions have decisions, phase 09 is ready to start.

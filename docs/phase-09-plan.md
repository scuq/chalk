# Phase 09 — Plan

**Status**: planning, not yet started.

**Scope**: replace the device-ensure shim with real auth. Add passkeys, usernames, recovery codes, a single admin user, invite-only registration via email, and email change with re-verification. Rewrite the hub connection model to support multiple concurrent connections per user.

This document is the spec phase 09 implementation should follow. Decisions are marked **DECISION**; open questions are marked **OPEN**.

## Goals

1. Get rid of `ensureDeviceForTesting` and the hard-coded alice/bob/carol UUIDs. Real users must register and log in.
2. Authentication is passkey-based (WebAuthn). No passwords. Recovery via 24-word codes.
3. Registration is invite-only. Existing users invite new users by email. There is no global registration switch.
4. Exactly one admin user, bootstrapped from an env var on first startup. Admin's only job is user management; the admin doesn't need to be involved in routine invites once the first user is set up.
5. Every user has a verified email address. The invite-click counts as the initial verification; subsequent email changes require fresh verification.
6. A user can have multiple concurrent connections (multiple tabs, multiple devices) without one evicting the other.
7. Existing dev fixtures (alice/bob/carol) continue to work via a dev-mode bypass.

## Non-goals (deferred)

- Multi-factor beyond passkey + recovery code
- Phone/SMS recovery
- Social login / OAuth
- Username changes (immutable post-registration)
- Cross-device passkey sync UI (rely on platform-native sync, e.g. iCloud Keychain)
- Rate limits on auth/invite endpoints — phase 13
- Anti-spam on email — phase 13
- Account self-deletion write paths — phase 11
- Visibility of email to other users — never; emails are private between user and server (admin-visible only)

## What changes for the user

**Today (phase 08c)**:
- Open browser → SPA generates a random `deviceId` → opens WebSocket → `ensureDeviceForTesting` maps to alice. Everyone is "alice."

**After phase 09**:

Three distinct flows:

### First-ever startup (admin bootstrap)

- Operator sets `CHALK_ADMIN_USERNAME`, `CHALK_ADMIN_EMAIL`, optional `CHALK_ADMIN_DISPLAY_NAME` before first run
- chalkd boots, runs migrations, finds no admin row → creates admin user with `role='admin'`, no passkey yet
- chalkd prints a one-time bootstrap URL to stderr:
  ```
  CHALK ADMIN BOOTSTRAP
  Visit this URL within 24 hours to register your admin passkey:
    https://chalk.example/admin/bootstrap?token=abc123...
  This URL will not be shown again. To reissue: chalkd admin-bootstrap-token
  ```
- Admin clicks URL → SPA shows "register your admin passkey" → WebAuthn ceremony → admin gets 24-word recovery code → admin is now usable
- The bootstrap URL is single-use and expires in 24h. To reissue, the operator runs a CLI command: `chalkd admin-bootstrap-token` (separate code path from regular HTTP endpoints; not exposed over the network)

### Inviting a new user

- Existing user (admin or otherwise) creates invite: `POST /api/invites { email, note? }`
- Server validates: invitee isn't already a user, email isn't blacklisted, no active invite for this email exists
- Server generates token, persists invite row, sends email to invitee via SMTP (or in dev mode: logs the URL to stderr)
- Inviter sees the invite in their "my invites" panel with a copy-URL fallback (in case email fails or they want to share the link manually)

### Registering as an invitee

- Invitee receives email with link to `https://chalk.example/i/<token>`
- Invitee clicks link → SPA loads → calls `GET /api/auth/invite/<token>` → server returns `{ email, inviter_username, expires_at }`
- SPA shows registration screen: "You've been invited by @scuq to join chalk as <email>. Pick a username and display name." Username is chosen by the invitee (not pre-reserved); display name is free-form.
- Invitee submits → WebAuthn ceremony → server creates user with `email_verified_at = now()` (invite click is the verification) → invite is marked used → user gets session + 24-word recovery code
- New user is now a full member of chalk and can create their own invites

### Subsequent logins

- User opens chalk → SPA calls `GET /api/auth/me` → if no valid session, shows login screen
- Login screen has a username field and "log in with passkey" button → WebAuthn ceremony → session token cookie set → SPA reloads into chat

### Changing email

- User in settings: "change email"
- Submits new email → server validates not blacklisted, not in use → creates pending verification → sends verification email to new address (and notification email to old address if SMTP configured)
- User clicks link in new inbox → server marks email change complete, updates `users.email` and `users.email_verified_at = now()`
- Old email no longer associated with the account

### Admin moderation (rare)

- Admin logs in normally (same login flow)
- Admin's SPA shows an additional "users" tab
- List view: username, display name, email, role, status (active/blocked/deleted), last seen
- Per-user actions: block (reversible), unblock, soft-delete, purge (hard delete)
- Email blacklist view: list of blacklisted emails with `clear` action per entry

## Decisions

### DECISION 1: usernames, display names, handles

We keep both shapes:

- **username**: chosen at registration, immutable, globally unique (case-insensitive via CITEXT), used for login (`@scuq` in the login screen). Constraint: `^[a-z0-9_]{3,32}$`.
- **display_name** (also called handle in the existing schema): mutable, not unique, shown in DM labels and status badges. Defaults to username at registration; user can change anytime.

The existing `users.handle` column is renamed to `users.display_name` for clarity. Wire frames use `display_name` going forward. The existing `handle` field in welcome/channel summaries is renamed in migration 0011.

Wire impact: `WelcomePayload` and `ChannelMember` change `handle` → `display_name`. SPA reducer and components mirror. This is a breaking change but it's an unstable interface and we're already touching everything.

### DECISION 2: email is mandatory and private

- Every user has a non-null, unique, verified `email`.
- Email is **never** visible to other users in any wire frame, UI, or API response.
- Email is admin-visible via the admin-only `list_users` endpoint.
- Email-of-record is server-known. Used for invites, verification, and admin contact only.
- No "send notification email when X" features in phase 09 beyond the bootstrap, invite, verification, and notify-on-change paths.

### DECISION 3: WebAuthn library

Use [`github.com/go-webauthn/webauthn`](https://github.com/go-webauthn/webauthn) — MIT licensed, actively maintained, the standard Go choice.

Wrap it behind `internal/auth` so we can swap implementations later:

```go
type AuthService interface {
    BeginRegistration(ctx, user) (challenge, sessionData, error)
    FinishRegistration(ctx, user, sessionData, response) (credential, error)
    BeginAuthentication(ctx, username) (challenge, sessionData, error)
    FinishAuthentication(ctx, username, sessionData, response) (credential, error)
}
```

User verification (UV): "preferred" — biometric/PIN if the authenticator supports it; not required.

### DECISION 4: session model

Opaque server-side tokens, stored in `sessions` table, returned via Set-Cookie (HttpOnly, Secure, SameSite=Strict).

**Schema**:
```sql
CREATE TABLE sessions (
  token         BYTEA       PRIMARY KEY,            -- 32 random bytes
  user_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  user_agent    TEXT,
  ip_address    INET
);
CREATE INDEX sessions_user_idx     ON sessions(user_id);
CREATE INDEX sessions_expires_idx  ON sessions(expires_at);
```

**TTL**: 30 days sliding (`last_used_at` updated on each WS handshake). Janitor sweeps expired rows hourly.

**Revocation paths**: explicit logout, "logout all sessions," admin block (kills all sessions for a user), and account purge (cascade).

**Multiple sessions per user**: supported by the schema; "active sessions" UI shown in settings (phase 09c).

### DECISION 5: recovery codes

24 BIP-39 English words (256 bits of entropy from 264 available). Shown to the user once at registration. Stored as an argon2id hash.

**Schema**:
```sql
CREATE TABLE recovery_codes (
  user_id     UUID        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  hash        BYTEA       NOT NULL,         -- argon2id of the 24-word phrase
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  used_at     TIMESTAMPTZ                   -- non-null once consumed
);
```

One code per user. Using it issues a new session AND invalidates the code. User is shown the "generate a new code" screen immediately and must complete it before chat is accessible.

### DECISION 6: passkey schema

```sql
CREATE TABLE passkeys (
  credential_id    BYTEA       PRIMARY KEY,        -- WebAuthn credential ID
  user_id          UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key       BYTEA       NOT NULL,           -- CBOR-encoded COSE key
  sign_count       BIGINT      NOT NULL DEFAULT 0,
  transports       TEXT[]      NOT NULL DEFAULT '{}',
  name             TEXT,                            -- user-chosen, "my iPhone"
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at     TIMESTAMPTZ
);
CREATE INDEX passkeys_user_idx ON passkeys(user_id);
```

Multiple passkeys per user, each independently revocable. `sign_count` is required by WebAuthn for clone detection.

### DECISION 7: connection model rewrite

Today: `map[deviceID]*Conn` with "new wins" eviction.

After: `map[userID]*userConnSet` where each conn has a unique server-generated `connID`. Multiple tabs/devices coexist. Fan-out iterates the set; echo-suppression is per-conn rather than per-device.

```go
type Hub struct {
    byUser   sync.Map // map[userID]*userConnSet
    byConnID sync.Map // map[connID]*Conn  -- for direct lookup
}

type userConnSet struct {
    mu    sync.Mutex
    conns map[string]*Conn  // keyed by connID
}
```

Implementation in `internal/server/hub.go`. Send-channel slow-consumer policy: non-blocking select with default-drop. Slow conn that misses a fan-out is reconnected via the catch-up-via-seq mechanism that already exists.

### DECISION 8: admin model

**Exactly one admin user.** Bootstrapped on first startup.

**Bootstrap env vars (consulted only when no admin row exists)**:
- `CHALK_ADMIN_USERNAME` — required on first startup; e.g. `scuq`
- `CHALK_ADMIN_EMAIL`    — required on first startup
- `CHALK_ADMIN_DISPLAY_NAME` — optional; defaults to username

**Schema enforcement**:
```sql
ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'
  CHECK (role IN ('user','admin'));

-- Admin singleton: at most one row with role='admin'.
CREATE UNIQUE INDEX users_single_admin_idx ON users(role)
  WHERE role = 'admin';

-- Admin can never be deleted by ordinary DELETE.
CREATE OR REPLACE FUNCTION refuse_admin_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.role = 'admin' THEN
    RAISE EXCEPTION 'cannot delete admin user';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER admin_delete_guard BEFORE DELETE ON users
  FOR EACH ROW EXECUTE FUNCTION refuse_admin_delete();
```

**Reserved usernames** (hardcoded in `internal/auth`):
```
admin, administrator, root, system, chalk, chalkd,
support, help, moderator, mod, official, noreply, postmaster
```

The admin's chosen username (from env) is allowed even if it matches the reserved list — the env-set admin name is the only legitimate use.

**Admin bootstrap recovery**: if the admin is locked out, the operator runs `chalkd admin-bootstrap-token` on the server. This is a CLI subcommand, not an HTTP endpoint. It:
1. Verifies no admin session is active in the last hour (sanity check)
2. Generates a fresh single-use token, expires in 24h
3. Prints the bootstrap URL to stdout
4. Stores the token in the `admin_bootstrap_tokens` table

Schema:
```sql
CREATE TABLE admin_bootstrap_tokens (
  token       BYTEA       PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ
);
CREATE UNIQUE INDEX admin_bootstrap_tokens_active_idx
  ON admin_bootstrap_tokens((1))      -- single-row partial unique
  WHERE used_at IS NULL AND expires_at > now();
```

The partial unique index `((1))` enforces "at most one active bootstrap token at a time."

**Admin actions** (admin-only wire frames):
- `list_users` — paginated, with username, display_name, email, role, status, last_seen
- `block_user{id, reason?}` — sets `blocked_at`; kills sessions; auto-revokes outstanding invites by that user
- `unblock_user{id}` — clears `blocked_at`; user can log in normally
- `soft_delete_user{id}` — sets `deleted_at`; kills sessions; blocks login; messages stay
- `purge_user{id}` — hard delete; email goes to blacklist; cascades wipe most data; messages have sender_id set to NULL (migration 0009 made this nullable)
- `list_email_blacklist` — see all blacklisted emails
- `clear_email_blacklist{email}` — remove an entry from the blacklist
- `force_email_change{user_id, new_email}` — admin-driven email change without verification (used to resolve "user lost their email entirely" situations)

### DECISION 9: invite + email flow

**Invite schema**:
```sql
CREATE TABLE invites (
  token        BYTEA       PRIMARY KEY,             -- 32 random bytes
  email        CITEXT      NOT NULL,
  inviter_id   UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note         TEXT,                                  -- inviter's free-form memo
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,                  -- created_at + 4 days
  used_at      TIMESTAMPTZ,
  used_by      UUID        REFERENCES users(id) ON DELETE SET NULL,
  revoked_at   TIMESTAMPTZ
);

-- One active invite per email at a time.
CREATE UNIQUE INDEX invites_active_email_idx
  ON invites(email)
  WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > now();

CREATE INDEX invites_inviter_idx ON invites(inviter_id);
CREATE INDEX invites_expires_idx ON invites(expires_at)
  WHERE used_at IS NULL AND revoked_at IS NULL;
```

**Default invite TTL**: 4 days. Hardcoded for now; configurable later if needed.

**Email change schema additions** (extend `users`):
```sql
ALTER TABLE users
  ADD COLUMN email_verified_at        TIMESTAMPTZ,
  ADD COLUMN pending_email            CITEXT,
  ADD COLUMN pending_email_token      BYTEA,
  ADD COLUMN pending_email_expires_at TIMESTAMPTZ;

CREATE UNIQUE INDEX users_pending_email_idx
  ON users(pending_email)
  WHERE pending_email IS NOT NULL;
```

**Email change flow**:
1. User submits `change_email{new_email}`
2. Server validates: new_email shape OK, not blacklisted, not in any `users.email` (active or soft-deleted), not in any `users.pending_email`
3. Server stores `pending_email`, `pending_email_token` (32 random bytes), `pending_email_expires_at = now() + 24h`
4. Server sends verification email to **new** address with link `https://chalk.example/verify-email/<token>`
5. Server sends notification email to **old** address: "your email is being changed; if this wasn't you, ignore this message and the change will not take effect"
6. User clicks link in new inbox → `POST /api/auth/verify-email-change/<token>`
7. Server validates token, copies `pending_email → email`, sets `email_verified_at = now()`, clears all `pending_*` fields
8. If link expires or user cancels: `pending_*` cleared; `email` unchanged

**Email blacklist** (separate table):
```sql
CREATE TABLE email_blacklist (
  email           CITEXT      PRIMARY KEY,
  reason          TEXT        NOT NULL,             -- e.g. 'purged_user'
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by        UUID        REFERENCES users(id) ON DELETE SET NULL,
  former_user_id  UUID,                             -- denormalized; user row is gone
  former_username CITEXT                            -- denormalized; for admin UI
);
CREATE INDEX email_blacklist_added_at_idx ON email_blacklist(added_at);
```

**Blacklist entry policy**:
- Added automatically when a user is **purged** (hard delete)
- NOT added on **soft delete** (the user row remains; the unique constraint already blocks reuse)
- Removed by `clear_email_blacklist` admin action
- Bootstrapping the admin user bypasses the blacklist (so a previously-admin email can be re-bootstrapped after a fresh DB)

**Validation order at registration and email-change**:
1. Email shape (RFC 5322 reasonable subset)
2. Email not in `email_blacklist` (admin bootstrap bypasses)
3. Email not currently bound to a `users.email` (active or soft-deleted) or `users.pending_email`
4. (Registration only) Invite's email must match the chosen email (it always does — the user can't change the email of their own invite)

### DECISION 10: account deletion

Two flavors:

**Soft delete** (default for moderation):
- Sets `users.deleted_at = now()`
- Kills all sessions for that user
- User can't log in (login endpoint returns "account deleted")
- Messages stay; `sender_id` still points to the user row
- UI displays "(deleted)" for that sender's display name in MessageList
- User row persists indefinitely
- Email stays in `users.email` so the unique constraint blocks re-registration with that address

**Purge** (hard delete, for explicit requests):
- Deletes the `users` row entirely
- Cascading deletes from foreign keys handle most cleanup: sessions, passkeys, invites (sent or received), recovery codes, friend rows, channel memberships, presence
- `messages.sender_id` is set to NULL via the `ON DELETE SET NULL` from migration 0009
- Email goes to `email_blacklist` with `reason='purged_user'`
- UI displays "(deleted)" for null sender (same display as soft-deleted)
- Irreversible

Admin chooses soft (default) or purge (explicit flag) per action. Both available via wire frames; SPA admin panel exposes both.

### DECISION 11: email infrastructure

**Required for production**: SMTP host, port, username, password, from address, TLS mode.

```
CHALK_SMTP_HOST       (required if any other CHALK_SMTP_* is set)
CHALK_SMTP_PORT       (587 default)
CHALK_SMTP_USERNAME   (required if SMTP_HOST set)
CHALK_SMTP_PASSWORD   (required if SMTP_HOST set)
CHALK_SMTP_FROM       (required if SMTP_HOST set; e.g. "chalk <noreply@chalk.example>")
CHALK_SMTP_TLS        (starttls|implicit|none; default starttls)
```

**Dev mode** (no SMTP env vars set):
- Emails are written to stderr with a clear banner: `[mail] would send to alice@example.com: Subject: ...`
- Banner in the SPA: "dev mode — see server logs for verification links"
- All flows that depend on email (registration, email change, admin bootstrap) still work; the URL is just in the log instead of an inbox

**Library**: standard library `net/smtp` with a thin STARTTLS wrapper. About 80 lines. Avoid third-party SMTP libs.

**Package structure**:
```
internal/mail/
  mail.go        — type Mailer interface { Send(ctx, to, subject, body) error }
  smtp.go        — type smtpMailer; production
  log.go         — type logMailer; dev
  templates.go   — Go text/template for invite, verification, notification emails
```

**Email shape**: plain text only. No HTML. No tracking pixels.

Subject lines and template names:
- `invite.txt` → `Subject: You've been invited to chalk`
- `verify_email_change.txt` → `Subject: Confirm your new chalk email`
- `notify_email_change.txt` → `Subject: Your chalk email is being changed`
- `admin_bootstrap.txt` → only sent via stderr; never via SMTP (security)

### DECISION 12: unblock policy

If a user is blocked for any duration (1 hour or 1 year) and then unblocked, they can log in normally with their existing passkey. No forced re-enrollment.

If their authenticator was lost or stolen during the block, they go through the standard recovery-code flow themselves — same as any user who lost a passkey.

## Wire protocol changes

### New auth-related frame types (over WebSocket)

The WebAuthn ceremonies happen over HTTP (see below); these WebSocket frames are for things that don't need the ceremony shape:

```
hello (modified)
  before: { device_id }
  after:  { session_token?, device_id? }    // both optional; cookie used if not specified

welcome (modified)
  before: { user_id, device_id, handle, channels }
  after:  { user_id, device_id, username, display_name, role, channels,
            session_expires_at, email_verified, has_outstanding_recovery_warning }

logout                  client → server     {}
logout_ack              server → client     {}

list_passkeys           client → server     {}
list_passkeys_ack       server → client     { passkeys: [{credential_id_hex, name, created_at, last_used_at, transports}] }

revoke_passkey          client → server     { credential_id_hex }
revoke_passkey_ack      server → client     { credential_id_hex }

list_sessions           client → server     {}
list_sessions_ack       server → client     { sessions: [{id, current, created_at, last_used_at, user_agent, ip_address}] }

revoke_session          client → server     { session_id_hex }
revoke_session_ack      server → client     { session_id_hex }

list_invites            client → server     {}
list_invites_ack        server → client     { invites: [{token_hex, email, note, created_at, expires_at, used_at}] }

create_invite           client → server     { email, note? }
create_invite_ack       server → client     { token_hex, email, expires_at, invite_url }

revoke_invite           client → server     { token_hex }
revoke_invite_ack       server → client     { token_hex }

change_email            client → server     { new_email }
change_email_ack        server → client     { pending_email, expires_at }

cancel_email_change     client → server     {}
cancel_email_change_ack server → client     {}

update_display_name     client → server     { display_name }
update_display_name_ack server → client     { display_name }
```

### New admin-only frame types

All require `role='admin'` in the caller's session. Server returns auth error otherwise.

```
list_users              admin → server      { offset?, limit?, query? }
list_users_ack          server → admin      { users: [{id, username, display_name, email, role, blocked_at, deleted_at, last_seen, email_verified_at}], total }

block_user              admin → server      { user_id, reason? }
block_user_ack          server → admin      { user_id, blocked_at }

unblock_user            admin → server      { user_id }
unblock_user_ack        server → admin      { user_id }

soft_delete_user        admin → server      { user_id }
soft_delete_user_ack    server → admin      { user_id, deleted_at }

purge_user              admin → server      { user_id }
purge_user_ack          server → admin      { user_id, blacklisted_email }

list_email_blacklist    admin → server      {}
list_email_blacklist_ack server → admin     { entries: [{email, reason, added_at, former_username}] }

clear_email_blacklist   admin → server      { email }
clear_email_blacklist_ack server → admin    { email }

force_email_change      admin → server      { user_id, new_email }
force_email_change_ack  server → admin      { user_id, new_email }
```

### HTTP endpoints (WebAuthn ceremonies and email-link flows)

WebAuthn's challenge-response naturally fits HTTP. Email verification links are HTTP by nature. Session cookies are set via HTTP responses.

```
POST   /api/auth/register/begin          { invite_token, username, display_name }
                                          → { challenge, options }
POST   /api/auth/register/finish         { invite_token, credential_response }
                                          → 200 + Set-Cookie + { session_expires_at, recovery_words[24] }

POST   /api/auth/authenticate/begin      { username }
                                          → { challenge, options }
POST   /api/auth/authenticate/finish     { credential_response }
                                          → 200 + Set-Cookie + { session_expires_at }

POST   /api/auth/recovery                { username, words[24] }
                                          → 200 + Set-Cookie + { regenerate_required: true }
POST   /api/auth/recovery/regenerate     {}
                                          → { recovery_words[24] }

POST   /api/auth/logout                  {}
                                          → 204 + Set-Cookie clearing

GET    /api/auth/me                      → { user_id, username, display_name, role, email_verified_at, session_expires_at }

GET    /api/auth/invite/{token}          → { email, inviter_username, expires_at, status }
                                            or 404 / 410 (expired/used/revoked)

POST   /api/auth/verify-email-change/{token}  → 200 + redirect to /

POST   /admin/bootstrap                  { token, username (must match env), credential_response }
                                          → 200 + Set-Cookie + { recovery_words[24] }
                                            (admin's own registration ceremony)
```

The session cookie is HttpOnly + Secure + SameSite=Strict. SPA never reads the raw token; it discovers identity via `/api/auth/me`.

## Schema migrations

All additive, all idempotent. Order matters; each depends on its predecessors.

```
migrations/0011_users_extend.sql
  - users.username CITEXT UNIQUE NOT NULL  (backfill from handle for fixtures)
  - users.display_name TEXT NOT NULL       (rename of existing handle column)
  - users.email CITEXT UNIQUE NOT NULL     (backfill with placeholder for fixtures)
  - users.role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin'))
  - users.email_verified_at TIMESTAMPTZ
  - users.blocked_at TIMESTAMPTZ
  - users.blocked_reason TEXT
  - users.deleted_at TIMESTAMPTZ
  - users.last_seen TIMESTAMPTZ NOT NULL DEFAULT now()
  - users.pending_email CITEXT
  - users.pending_email_token BYTEA
  - users.pending_email_expires_at TIMESTAMPTZ
  - users_pending_email_idx partial unique
  - users_single_admin_idx partial unique
  - refuse_admin_delete trigger
  - username shape constraint

migrations/0012_passkeys.sql               — passkeys table
migrations/0013_sessions.sql               — sessions table
migrations/0014_recovery_codes.sql         — recovery_codes table

migrations/0015_devices_link.sql
  - devices.passkey_credential_id BYTEA REFERENCES passkeys(credential_id) ON DELETE SET NULL

migrations/0016_invites.sql                — invites table + indexes
migrations/0017_admin_bootstrap.sql        — admin_bootstrap_tokens table
migrations/0018_email_blacklist.sql        — email_blacklist table
```

8 migrations. None destructive. Fixtures need email backfill — see "Dev fixtures" below.

## Dev fixtures

alice/bob/carol need to keep working in `make dev`. They get:

- Real passkeys: no. They get a dev-mode login bypass.
- Real emails: backfilled with placeholders like `alice@localhost.invalid` (the `.invalid` TLD is reserved precisely for cases like this).
- Real usernames: backfilled from existing `handle` (so username=alice, display_name=alice).

**Dev login bypass**: when `CHALK_DEV=1` is set, an additional HTTP endpoint is registered:

```
POST /api/dev/login { username }   → 200 + Set-Cookie + { session_expires_at }
```

This endpoint:
- Returns 404 if `CHALK_DEV` is not set
- Returns 404 in production builds (compile-time `//go:build dev` or runtime `panic if !devmode`)
- Issues a session for the named fixture user without any passkey check
- Logs prominently to stderr that a dev login happened

The dev SPA shows shortcut buttons: "log in as alice / bob / carol" — visible only when `CHALK_DEV=1`. In production these buttons aren't even rendered.

This means:
- Real registration / auth / recovery flows are fully testable via integration tests with a virtual authenticator
- `make dev` workflow stays painless (one click to be alice, no email shenanigans)
- The bypass is gated by both build tag and runtime check (belt + suspenders)

## SPA changes

### New components

```
web/src/components/auth/
  RegisterScreen.tsx          — invitee path: pick username + display_name, WebAuthn create
  LoginScreen.tsx             — pick username, WebAuthn get
  RecoveryScreen.tsx          — 24-word input, regenerate code prompt
  RecoveryWordsDisplay.tsx    — shown at registration; copy/download; "I saved these" gate
  BootstrapAdminScreen.tsx    — admin's first-time passkey enrollment from the bootstrap URL
  VerifyEmailChangeScreen.tsx — landing page for verify-email-change link clicks

web/src/components/settings/
  ProfilePanel.tsx            — change display name, change email
  SessionsPanel.tsx           — list/revoke sessions, "logout everywhere"
  PasskeysPanel.tsx           — list/revoke passkeys, add another passkey
  InvitesPanel.tsx            — my outstanding invites, create new, revoke
  RecoveryPanel.tsx           — regenerate recovery code

web/src/components/admin/
  UsersTab.tsx                — admin user list with actions
  BlacklistTab.tsx            — email blacklist with clear actions
```

### State changes

```ts
type AuthStage = "bootstrapping" | "registering" | "logging-in" | "recovering" |
                 "verifying-email" | "authed";

interface AppState {
  // ... existing ...
  authStage: AuthStage;
  user: { id, username, display_name, role, email_verified_at, session_expires_at } | null;
  // chat UI renders only when authStage === "authed"
}
```

### Storage

- Session cookie: HttpOnly, set by server, SPA never reads
- Username: cached in localStorage as "last used" for the login prompt UX (only the username string)
- No tokens or passkey material is ever in localStorage

## Server changes

### New packages

```
internal/auth/
  service.go         — AuthService interface wrapping go-webauthn
  registration.go    — Begin/FinishRegistration handlers + invite redemption
  authentication.go  — Begin/FinishAuthentication
  session.go         — token mint, validate, refresh, revoke
  recovery.go        — 24-word generation (BIP-39), argon2id hash/verify
  invite.go          — create, list, revoke, validate, redeem
  bootstrap.go       — admin bootstrap token lifecycle + CLI subcommand
  middleware.go      — http.Handler middleware: requires session, optional role check
  reserved.go        — reserved usernames list + check

internal/mail/
  mail.go            — Mailer interface
  smtp.go            — production SMTP implementation
  log.go             — dev log implementation
  templates.go       — text/template for emails

internal/admin/
  service.go         — list/block/unblock/soft_delete/purge users
  blacklist.go       — email_blacklist CRUD
```

### Modified packages

```
internal/server/
  ws.go              — hello reads session from cookie; removes ensureDeviceForTesting
  hub.go             — connection model rewrite (DECISION 7)
  http_auth.go       — new file: /api/auth/* handlers
  http_admin.go      — new file: /admin/* handlers (admin bootstrap UI page)
  http.go            — wire up new routes
  server.go          — startup checks admin existence, prints bootstrap URL on first run

internal/store/
  users.go           — rename handle→display_name; add Username, Email, Role, EmailVerifiedAt,
                       BlockedAt, DeletedAt, LastSeen, PendingEmail, etc.
                       New methods: GetUserByUsername, BackfillFromHandle (migration helper),
                       BlockUser, UnblockUser, SoftDeleteUser, PurgeUser,
                       BeginEmailChange, FinishEmailChange, CancelEmailChange,
                       BootstrapAdmin (idempotent)
  sessions.go        — new file
  passkeys.go        — new file
  recovery_codes.go  — new file
  invites.go         — new file
  email_blacklist.go — new file
  admin_bootstrap.go — new file
  devices.go         — LinkPasskey method added

cmd/chalkd/
  main.go            — admin bootstrap on first run + bootstrap URL print
  admin_bootstrap.go — new file: CLI subcommand "chalkd admin-bootstrap-token"
```

## Test plan

### Unit tests

```
internal/auth/
  registration_test.go    — happy path, duplicate username, malformed credential, dead invite,
                            mismatched email, blacklisted email
  authentication_test.go  — happy path, unknown user, wrong credential, blocked user,
                            deleted user, sign_count clone detection
  session_test.go         — mint, validate, refresh expiry, revoke, multi-session
  recovery_test.go        — gen entropy, hash/verify, one-shot use enforcement
  invite_test.go          — create, list, revoke, expire, redeem, double-redeem refused
  bootstrap_test.go       — token gen, single-active-token enforcement, expiry
  reserved_test.go        — reserved usernames refused
  middleware_test.go      — auth required, role required

internal/admin/
  service_test.go         — block kills sessions, soft delete kills sessions, purge cascades,
                            blacklist add on purge, admin singleton enforced
  blacklist_test.go       — CRUD + bootstrap bypass

internal/mail/
  smtp_test.go            — happy path via test server (smtp.MockServer pattern),
                            auth failure, starttls negotiation
  log_test.go             — log line shape

internal/store/
  users_phase09_test.go   — email-change state machine; pending-email partial unique;
                            blocked/deleted/purged transitions

internal/server/
  hub_phase09_test.go     — multi-conn-per-user; fanout-except-self-conn;
                            disconnect-doesn't-evict-siblings
```

### Integration tests (require Postgres)

```
test/integration/
  auth_test.go            — full register, full login, full recovery
  invite_test.go          — invite → register → user exists with verified email
  email_change_test.go    — full flow + simultaneous-change race; blacklist resolution
  admin_test.go           — block, unblock, soft delete, purge, blacklist clear
  bootstrap_test.go       — fresh DB, admin bootstrap URL works, second use fails,
                            CLI reissue
  multi_conn_test.go      — same user, two ws connections, both receive a message
```

### E2E tests

```
test/e2e/
  auth.spec.ts            — register new account (with virtual authenticator),
                            log out, log back in
  recovery.spec.ts        — use recovery code, register fresh passkey, verify works
  invite.spec.ts          — admin invites scuq, scuq registers, scuq invites alice,
                            alice registers as alice
  email_change.spec.ts    — change email, click link in (mock) inbox, verify
  admin.spec.ts           — block/unblock, soft delete (user can't log in),
                            purge (email goes to blacklist)
  multi_tab.spec.ts       — open two tabs as same user, send from A, see in B
```

Playwright virtual authenticator + a mock SMTP server (intercepts mail and exposes a `GET /mock-inbox/<email>` endpoint that the tests read) makes this all automatable.

## Phase split

This is too big for one merge. Split into:

**09a — hub rewrite** (no auth changes)
- DECISION 7 only
- New connID-keyed connection model
- Echo-suppression per conn, not per device
- Multi-tab works
- Independent of all auth work; ships first
- ~600 lines; estimated 1-2 fix cycles

**09b — auth core**
- DECISIONS 1, 2, 3, 4, 5, 6, 8 (partial — admin bootstrap), 11 (mail)
- Migrations 0011-0015 + 0017
- `internal/auth`, `internal/mail`
- Registration/auth/recovery HTTP endpoints
- SPA RegisterScreen, LoginScreen, RecoveryScreen
- Admin bootstrap flow
- Dev login bypass
- ~3500 lines across server + SPA; estimated 4-5 fix cycles

**09c — invites + email change**
- DECISIONS 9, parts of 8 (invite-specific admin actions)
- Migrations 0016, 0018
- `internal/auth/invite.go`
- Email change flow
- SPA InvitesPanel, ProfilePanel, VerifyEmailChangeScreen
- ~1500 lines; estimated 2-3 fix cycles

**09d — admin moderation**
- DECISION 8 (full), DECISION 10
- `internal/admin`
- Admin frames + admin tabs in SPA
- Email blacklist UI
- Purge flow + blacklist auto-add
- ~1200 lines; estimated 2-3 fix cycles

Total estimate: 6800 lines across 9-13 fix cycles spread over 4 sub-phases. About the size of phase 08 (which was 8000 lines / 10 cycles).

## Open questions

These need decisions before code starts, but they're small enough they can wait until each sub-phase begins:

1. **CLI subcommand framework**. `chalkd admin-bootstrap-token` is the first non-server CLI command. Roll our own arg parsing or pull in `cobra`/`urfave/cli`? Prefer rolling our own; it's tiny.

2. **Where does the admin bootstrap URL get served?** A standalone HTTP route on chalkd itself, or printed and the operator pastes into an already-running SPA? The URL approach assumes chalkd is reachable from the operator's browser. For a self-hosted single-machine setup, yes. For a CI/headless deploy, the operator might want a CLI: `chalkd admin-bootstrap --register` that drives the WebAuthn ceremony from the command line. Probably the URL-served approach is fine for chalk's deployment model; document the constraint.

3. **Bootstrap admin's recovery code: shown via the SPA after passkey ceremony, or printed to server stderr?** Probably the SPA (consistent with the regular registration flow). The bootstrap URL itself is the only thing that needs to be in stderr.

4. **Block reasons**: free-form text, or an enum (`spam`, `harassment`, `other` with note)? Free-form is simpler; the admin can write whatever. Confirm.

5. **Backup passkey prompt at registration**. Many sites prompt "register a second passkey now" after the first. Soft prompt, easy to skip. Include in 09b or skip? Probably skip and add as 09c polish.

6. **WebAuthn relying party (RP) configuration**: `rp.id` and `rp.name` need to be set. For dev: `localhost`. For production: depends on the deploy URL. Read from env: `CHALK_RP_ID`, `CHALK_RP_NAME`. Confirm.

7. **Username shape constraint**: `^[a-z0-9_]{3,32}$` excludes hyphens, uppercase, unicode. Mastodon allows uppercase but it's case-folded. I'd keep this strict ASCII lowercase to avoid impersonation games (`scuq` vs `scυq` with a Greek upsilon). Confirm.

## Prep work before starting 09a

Independent of auth, but useful to clear up first:

- Compose a `tools/dev-reset-with-auth.sh` script that wipes the dev DB and re-bootstraps from scratch (so we can iterate on the bootstrap flow without hand-cleaning the DB each time)
- Decide on the `make dev` vs `make dev-prod-like` split — should `make dev` use the dev login bypass (zero email friction) and `make dev-prod-like` use a real SMTP-capable container with mailhog? Probably yes; spec this in the 09b PR.

## Prep work before starting 09b

- Read [go-webauthn](https://pkg.go.dev/github.com/go-webauthn/webauthn) docs end to end
- Build a 30-line throwaway registration ceremony POC outside the chalk repo
- Read SimpleWebAuthn's browser library or roll our own thin wrapper around `navigator.credentials.*`
- Choose a mock SMTP library for tests ([smtpmock](https://github.com/mocktools/go-smtp-mock) is popular and simple)

## Out of scope (write down so we don't forget)

- Email recovery
- Phone / SMS
- Social login
- Username changes (immutable)
- Encrypted email (server-visible by necessity)
- Username search / discovery
- Two distinct admin users (single admin only)
- Email visibility to other users (private)
- Rate limits on auth/invite endpoints (phase 13)

When the open questions above have decisions, phase 09a can start.
-- chalk -- migration 0050 (80-2: ephemeral voice channels + guest fence)
--
-- Phase 80 lets people WITHOUT a chalk account join one voice channel from a
-- magic link. A guest is a full cryptographic principal (user row, session,
-- membership, identity, space-key wrap) but a sharply restricted database
-- principal: connections serving a guest run as the chalk_guest role, and
-- everything it may touch is enumerated here as grants + FORCE row-level
-- security policies. The fence is a database invariant, not an application
-- allowlist -- a handler bug on the guest path hits `permission denied`, not
-- another user's data.
--
-- Roles (see docs/phases/PHASE-80-EPHEMERAL.md):
--   chalk        owner (container-bootstrap superuser); migrations in dev
--   chalk_app    chalkd's normal pool; non-superuser member of chalk, so it
--                holds owner rights for migrations + partition DDL without
--                being a superuser session
--   chalk_guest  ONLY connections serving a guest; no membership, no BYPASSRLS
--
-- chalkctl creates the roles with LOGIN + password at deploy time (80-1); the
-- guarded DO block below creates them NOLOGIN for dev stacks and test
-- databases where chalkctl never ran. GRANT/POLICY statements need the roles
-- to exist, which is why the block comes first.
--
-- Guest transactions open with
--     SET LOCAL chalk.guest_user    = '<uuid>';
--     SET LOCAL chalk.guest_channel = '<uuid>';
-- (issued by store.Guest.withTx, 80-3). Policies read them through the
-- NULLIF(current_setting(..., true), '') helpers: unset -> NULL -> every
-- comparison is NULL -> zero rows. A transaction that forgot the SET LOCALs
-- sees nothing at all. That is the correct failure direction.
--
-- FORCE vs ENABLE: chalk_app inherits table ownership through its membership
-- in chalk, and plain ENABLE exempts owners -- so FORCE plus an explicit
-- permissive chalk_app policy keeps the fence meaningful even if a guest
-- pool is ever misconfigured to connect as an owner-ish role. (Superusers
-- always bypass RLS; the dev stack's chalk user is one, which is fine.)
--
-- RLS on the partitioned messages table: policies attached to the parent
-- apply to queries THROUGH the parent, which is the only way the app ever
-- touches messages. (Asserted live by the 80-3 grant-matrix test.)

BEGIN;

-- ---- roles (dev/test bootstrap; chalkctl owns the LOGIN + password) ---------
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chalk_app') THEN
    CREATE ROLE chalk_app;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'chalk_guest') THEN
    CREATE ROLE chalk_guest;
  END IF;
  -- Membership gives chalk_app owner rights (DDL) without superuser. Guarded
  -- twice: the grant needs role chalk to exist (custom deployments may own
  -- the schema under another name), and in production this migration runs AS
  -- chalk_app, which may not re-grant its own membership (no ADMIN OPTION) --
  -- chalkctl has already granted it there.
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'chalk')
     AND NOT EXISTS (
       SELECT FROM pg_auth_members am
         JOIN pg_roles g ON g.oid = am.roleid
         JOIN pg_roles m ON m.oid = am.member
        WHERE g.rolname = 'chalk' AND m.rolname = 'chalk_app')
  THEN
    GRANT chalk TO chalk_app;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO chalk_app, chalk_guest;

-- ---- ephemeral channels -----------------------------------------------------
-- Ephemeral-ness is a COLUMN, not a channel_type: a third enum value would
-- break the scratchpad purge, JoinVoice, CreateChannel validation and the
-- client's unread suppression (plan §"Ephemeral-ness is a column").
ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- An ephemeral channel is always a plain voice channel. Schema-level so no
-- handler bug can mint an expiring text channel or DM.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channels_ephemeral_voice_chk'
  ) THEN
    ALTER TABLE channels
      ADD CONSTRAINT channels_ephemeral_voice_chk
      CHECK (expires_at IS NULL OR (channel_type = 'voice' AND NOT is_dm));
  END IF;
END $$;

-- The expiry janitor's sweep: "which channels are past due".
CREATE INDEX IF NOT EXISTS channels_expiry_idx
  ON channels (expires_at) WHERE expires_at IS NOT NULL;

-- ---- guest marker on users --------------------------------------------------
-- NULL for every real user. For a guest it names the ONE channel the guest
-- exists for, and the CASCADE is the load-bearing deletion path: purging the
-- channel row takes the guest users rows (and via them sessions, devices,
-- memberships, identities) down in the same statement.
--
-- The FK cycle with channels.created_by (SET NULL) is legal but means a guest
-- must NEVER become channels.created_by -- the application fence (80-9)
-- refuses it, and the 80-4 purge test asserts it.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS guest_channel_id UUID REFERENCES channels(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS users_guest_channel_idx
  ON users (guest_channel_id) WHERE guest_channel_id IS NOT NULL;

-- ---- ephemeral tables -------------------------------------------------------
-- ephemeral_invites: one row per magic link. The creator derives everything
-- client-side from the link secret (which the server NEVER sees): lookup =
-- SHA-256("chalk/join-lookup" || secret)[:16], the guest identity keys from
-- HKDF(secret), and the space-key wrap sealed to that identity with the
-- reserved guest_user_id in its AAD. The parked bytes become the guest's
-- users/identity/channel_keys rows at redemption (80-8), which is what makes
-- key substitution by the server pointless: a substituted key is one the
-- creator did not derive, so the wrap does not open.
CREATE TABLE IF NOT EXISTS ephemeral_invites (
  lookup        BYTEA        PRIMARY KEY,
  channel_id    UUID         NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  created_by    UUID         NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  -- Reserved by the creator; no FK -- the users row exists only after
  -- redemption. UNIQUE so two links can never materialize the same principal.
  guest_user_id UUID         NOT NULL UNIQUE,
  x25519_pub    BYTEA        NOT NULL,
  ed25519_pub   BYTEA        NOT NULL,
  self_sig      BYTEA        NOT NULL,
  key_version   INTEGER      NOT NULL,
  wrap_suite    SMALLINT     NOT NULL,
  wrap_blob     BYTEA        NOT NULL,
  -- Creator-facing label ("link for Bob"); never shown to the guest.
  label         TEXT         NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ  NOT NULL,
  -- First redemption. Recorded, not enforced: the link keeps working until
  -- expires_at (same secret -> same identity), so a closed tab is not a
  -- lockout. Invite rows are deleted with the channel, never swept on expiry
  -- (an expired invite may still name a live guest).
  redeemed_at   TIMESTAMPTZ,
  revoked_at    TIMESTAMPTZ,

  CONSTRAINT ephemeral_invites_lookup_len  CHECK (octet_length(lookup) = 16),
  CONSTRAINT ephemeral_invites_x25519_len  CHECK (octet_length(x25519_pub) = 32),
  CONSTRAINT ephemeral_invites_ed25519_len CHECK (octet_length(ed25519_pub) = 32),
  CONSTRAINT ephemeral_invites_selfsig_len CHECK (octet_length(self_sig) = 64),
  CONSTRAINT ephemeral_invites_version_pos CHECK (key_version >= 1),
  CONSTRAINT ephemeral_invites_suite_pos   CHECK (wrap_suite >= 1),
  CONSTRAINT ephemeral_invites_blob_nonempty CHECK (octet_length(wrap_blob) > 0)
);

CREATE INDEX IF NOT EXISTS ephemeral_invites_channel_idx
  ON ephemeral_invites (channel_id);

-- ephemeral_guests: the materialized guest -> (channel, invite) mapping.
-- Resolved from the session token BEFORE the SET LOCALs can be issued, which
-- is why this table carries plain grants and no RLS below.
CREATE TABLE IF NOT EXISTS ephemeral_guests (
  user_id       UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  channel_id    UUID         NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  invite_lookup BYTEA        NOT NULL REFERENCES ephemeral_invites(lookup) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ephemeral_guests_channel_idx
  ON ephemeral_guests (channel_id);

-- ephemeral_identity_keys: guests' public identity keys, mirroring
-- identity_keys' shape minus generations (a guest never rotates). A separate
-- table keeps chalk_guest away from real identity rows entirely and keeps the
-- real table's trust chain (self-published rows only) intact.
CREATE TABLE IF NOT EXISTS ephemeral_identity_keys (
  user_id      UUID         PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  x25519_pub   BYTEA        NOT NULL,
  ed25519_pub  BYTEA        NOT NULL,
  self_sig     BYTEA        NOT NULL,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT ephemeral_identity_x25519_len  CHECK (octet_length(x25519_pub) = 32),
  CONSTRAINT ephemeral_identity_ed25519_len CHECK (octet_length(ed25519_pub) = 32),
  CONSTRAINT ephemeral_identity_selfsig_len CHECK (octet_length(self_sig) = 64)
);

-- ephemeral_sessions: guest sessions, mirroring sessions' shape. Living in
-- their own table is the strongest single win of the fence: chalk_guest gets
-- NO grant on sessions, so real users' tokens are not policy-filtered, they
-- are unreachable.
CREATE TABLE IF NOT EXISTS ephemeral_sessions (
  token         BYTEA        PRIMARY KEY,
  user_id       UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  last_used_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ  NOT NULL,
  user_agent    TEXT,
  ip_address    INET
);

CREATE INDEX IF NOT EXISTS ephemeral_sessions_user_idx    ON ephemeral_sessions (user_id);
CREATE INDEX IF NOT EXISTS ephemeral_sessions_expires_idx ON ephemeral_sessions (expires_at);

-- ---- policy helpers ---------------------------------------------------------
-- current_setting(..., true) returns NULL when unset -- but '' after a SET in
-- an earlier transaction on a reused pool connection. NULLIF folds both to
-- NULL so the ''::uuid cast can never raise inside a policy.
CREATE OR REPLACE FUNCTION chalk_guest_user() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
  $$ SELECT NULLIF(current_setting('chalk.guest_user', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION chalk_guest_channel() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE AS
  $$ SELECT NULLIF(current_setting('chalk.guest_channel', true), '')::uuid $$;

-- ---- the fence: grants + FORCE RLS ------------------------------------------
-- Ephemeral-only tables: plain grants, no RLS. Session/guest resolution has
-- to work before the SET LOCALs exist (the token IS how the ids are learned),
-- and every row in them is guest-world data. chalk_guest still cannot INSERT
-- invites/identities/sessions -- minting and materialization are chalk_app's
-- (the redemption transaction), so a guest connection cannot forge principals.
GRANT SELECT                 ON ephemeral_invites       TO chalk_guest;
GRANT SELECT                 ON ephemeral_guests        TO chalk_guest;
GRANT SELECT                 ON ephemeral_identity_keys TO chalk_guest;
GRANT SELECT, UPDATE, DELETE ON ephemeral_sessions      TO chalk_guest;

-- Shared tables. Grants say which columns/verbs are reachable at all;
-- policies below scope the rows to the guest's one channel. Everything not
-- named here (user_auth, sessions, identity_seed_wrap, friendships, invites,
-- attachments, governance, threads, reactions, preferences, presence, ...)
-- stays at zero grants: `permission denied`, not an empty result.
GRANT SELECT (id, handle, display_name) ON users TO chalk_guest;
GRANT SELECT                  ON identity_keys      TO chalk_guest;
GRANT SELECT                  ON channels           TO chalk_guest;
GRANT SELECT                  ON channel_members    TO chalk_guest;
GRANT SELECT                  ON channel_keys       TO chalk_guest;
GRANT SELECT, UPDATE          ON channel_seq        TO chalk_guest;
GRANT SELECT, INSERT, UPDATE  ON channel_reads      TO chalk_guest;
GRANT SELECT, INSERT, UPDATE  ON messages           TO chalk_guest;
GRANT SELECT, INSERT, UPDATE  ON channel_activity   TO chalk_guest;
GRANT SELECT, INSERT, UPDATE, DELETE ON voice_participants TO chalk_guest;
GRANT SELECT, INSERT          ON voice_signal_spool TO chalk_guest;
GRANT SELECT, INSERT, UPDATE  ON devices            TO chalk_guest;

-- FORCE RLS + a permissive chalk_app policy on every shared table the guest
-- can reach. The guest policies are additive (permissive) on top of zero
-- default visibility.
ALTER TABLE users              ENABLE ROW LEVEL SECURITY; ALTER TABLE users              FORCE ROW LEVEL SECURITY;
ALTER TABLE identity_keys      ENABLE ROW LEVEL SECURITY; ALTER TABLE identity_keys      FORCE ROW LEVEL SECURITY;
ALTER TABLE channels           ENABLE ROW LEVEL SECURITY; ALTER TABLE channels           FORCE ROW LEVEL SECURITY;
ALTER TABLE channel_members    ENABLE ROW LEVEL SECURITY; ALTER TABLE channel_members    FORCE ROW LEVEL SECURITY;
ALTER TABLE channel_keys       ENABLE ROW LEVEL SECURITY; ALTER TABLE channel_keys       FORCE ROW LEVEL SECURITY;
ALTER TABLE channel_seq        ENABLE ROW LEVEL SECURITY; ALTER TABLE channel_seq        FORCE ROW LEVEL SECURITY;
ALTER TABLE channel_reads      ENABLE ROW LEVEL SECURITY; ALTER TABLE channel_reads      FORCE ROW LEVEL SECURITY;
ALTER TABLE messages           ENABLE ROW LEVEL SECURITY; ALTER TABLE messages           FORCE ROW LEVEL SECURITY;
ALTER TABLE channel_activity   ENABLE ROW LEVEL SECURITY; ALTER TABLE channel_activity   FORCE ROW LEVEL SECURITY;
ALTER TABLE voice_participants ENABLE ROW LEVEL SECURITY; ALTER TABLE voice_participants FORCE ROW LEVEL SECURITY;
ALTER TABLE voice_signal_spool ENABLE ROW LEVEL SECURITY; ALTER TABLE voice_signal_spool FORCE ROW LEVEL SECURITY;
ALTER TABLE devices            ENABLE ROW LEVEL SECURITY; ALTER TABLE devices            FORCE ROW LEVEL SECURITY;

-- chalk_app sees everything (the server's existing behavior, unchanged).
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','identity_keys','channels','channel_members','channel_keys',
    'channel_seq','channel_reads','messages','channel_activity',
    'voice_participants','voice_signal_spool','devices']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_app ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY %I_app ON %I FOR ALL TO chalk_app USING (true) WITH CHECK (true)',
      t, t);
  END LOOP;
END $$;

-- Guest policies. Idempotent via DROP + CREATE (CREATE POLICY has no OR
-- REPLACE); the migrate runner applies each file once, but a manual re-run
-- must not error.

-- users / identity_keys: the guest itself plus its co-members. This is what
-- preserves the DTLS-fingerprint check on the guest's own call, and it
-- narrows today's serve-anyone handleFetchIdentity to the guest's one room.
DROP POLICY IF EXISTS users_guest ON users;
CREATE POLICY users_guest ON users FOR SELECT TO chalk_guest
  USING (id = chalk_guest_user()
         OR EXISTS (SELECT 1 FROM channel_members m
                     WHERE m.channel_id = chalk_guest_channel()
                       AND m.user_id = users.id));

DROP POLICY IF EXISTS identity_keys_guest ON identity_keys;
CREATE POLICY identity_keys_guest ON identity_keys FOR SELECT TO chalk_guest
  USING (user_id = chalk_guest_user()
         OR EXISTS (SELECT 1 FROM channel_members m
                     WHERE m.channel_id = chalk_guest_channel()
                       AND m.user_id = identity_keys.user_id));

DROP POLICY IF EXISTS channels_guest ON channels;
CREATE POLICY channels_guest ON channels FOR SELECT TO chalk_guest
  USING (id = chalk_guest_channel());

DROP POLICY IF EXISTS channel_members_guest ON channel_members;
CREATE POLICY channel_members_guest ON channel_members FOR SELECT TO chalk_guest
  USING (channel_id = chalk_guest_channel());

-- Only the guest's OWN wraps: rewrap-for-missing is not a guest job.
DROP POLICY IF EXISTS channel_keys_guest ON channel_keys;
CREATE POLICY channel_keys_guest ON channel_keys FOR SELECT TO chalk_guest
  USING (channel_id = chalk_guest_channel()
         AND recipient_id = chalk_guest_user());

DROP POLICY IF EXISTS channel_seq_guest_select ON channel_seq;
CREATE POLICY channel_seq_guest_select ON channel_seq FOR SELECT TO chalk_guest
  USING (channel_id = chalk_guest_channel());
DROP POLICY IF EXISTS channel_seq_guest_update ON channel_seq;
CREATE POLICY channel_seq_guest_update ON channel_seq FOR UPDATE TO chalk_guest
  USING (channel_id = chalk_guest_channel())
  WITH CHECK (channel_id = chalk_guest_channel());

DROP POLICY IF EXISTS channel_reads_guest ON channel_reads;
CREATE POLICY channel_reads_guest ON channel_reads FOR ALL TO chalk_guest
  USING (user_id = chalk_guest_user() AND channel_id = chalk_guest_channel())
  WITH CHECK (user_id = chalk_guest_user() AND channel_id = chalk_guest_channel());

-- messages: read the room, send as yourself, edit/tombstone only your own.
DROP POLICY IF EXISTS messages_guest_select ON messages;
CREATE POLICY messages_guest_select ON messages FOR SELECT TO chalk_guest
  USING (channel_id = chalk_guest_channel());
DROP POLICY IF EXISTS messages_guest_insert ON messages;
CREATE POLICY messages_guest_insert ON messages FOR INSERT TO chalk_guest
  WITH CHECK (channel_id = chalk_guest_channel()
              AND sender_device_id IN
                  (SELECT d.id FROM devices d WHERE d.user_id = chalk_guest_user()));
DROP POLICY IF EXISTS messages_guest_update ON messages;
CREATE POLICY messages_guest_update ON messages FOR UPDATE TO chalk_guest
  USING (channel_id = chalk_guest_channel()
         AND sender_device_id IN
             (SELECT d.id FROM devices d WHERE d.user_id = chalk_guest_user()))
  WITH CHECK (channel_id = chalk_guest_channel());

DROP POLICY IF EXISTS channel_activity_guest ON channel_activity;
CREATE POLICY channel_activity_guest ON channel_activity FOR ALL TO chalk_guest
  USING (channel_id = chalk_guest_channel())
  WITH CHECK (channel_id = chalk_guest_channel());

-- voice_participants: see the room, join/update/leave only as yourself.
DROP POLICY IF EXISTS voice_participants_guest_select ON voice_participants;
CREATE POLICY voice_participants_guest_select ON voice_participants FOR SELECT TO chalk_guest
  USING (channel_id = chalk_guest_channel());
DROP POLICY IF EXISTS voice_participants_guest_insert ON voice_participants;
CREATE POLICY voice_participants_guest_insert ON voice_participants FOR INSERT TO chalk_guest
  WITH CHECK (channel_id = chalk_guest_channel() AND user_id = chalk_guest_user());
DROP POLICY IF EXISTS voice_participants_guest_update ON voice_participants;
CREATE POLICY voice_participants_guest_update ON voice_participants FOR UPDATE TO chalk_guest
  USING (channel_id = chalk_guest_channel() AND user_id = chalk_guest_user())
  WITH CHECK (channel_id = chalk_guest_channel() AND user_id = chalk_guest_user());
DROP POLICY IF EXISTS voice_participants_guest_delete ON voice_participants;
CREATE POLICY voice_participants_guest_delete ON voice_participants FOR DELETE TO chalk_guest
  USING (channel_id = chalk_guest_channel() AND user_id = chalk_guest_user());

-- voice_signal_spool: spool signals into the room as yourself; read back only
-- traffic addressed to (or sent by) yourself. Delivery fetch + TTL sweep run
-- under chalk_app.
DROP POLICY IF EXISTS voice_signal_spool_guest_select ON voice_signal_spool;
CREATE POLICY voice_signal_spool_guest_select ON voice_signal_spool FOR SELECT TO chalk_guest
  USING (channel_id = chalk_guest_channel()
         AND (to_user = chalk_guest_user() OR from_user = chalk_guest_user()));
DROP POLICY IF EXISTS voice_signal_spool_guest_insert ON voice_signal_spool;
CREATE POLICY voice_signal_spool_guest_insert ON voice_signal_spool FOR INSERT TO chalk_guest
  WITH CHECK (channel_id = chalk_guest_channel() AND from_user = chalk_guest_user());

-- devices: your own rows plus co-members' (voice signalling addresses
-- devices; message rows resolve sender via devices).
DROP POLICY IF EXISTS devices_guest_select ON devices;
CREATE POLICY devices_guest_select ON devices FOR SELECT TO chalk_guest
  USING (user_id = chalk_guest_user()
         OR EXISTS (SELECT 1 FROM channel_members m
                     WHERE m.channel_id = chalk_guest_channel()
                       AND m.user_id = devices.user_id));
DROP POLICY IF EXISTS devices_guest_insert ON devices;
CREATE POLICY devices_guest_insert ON devices FOR INSERT TO chalk_guest
  WITH CHECK (user_id = chalk_guest_user());
DROP POLICY IF EXISTS devices_guest_update ON devices;
CREATE POLICY devices_guest_update ON devices FOR UPDATE TO chalk_guest
  USING (user_id = chalk_guest_user())
  WITH CHECK (user_id = chalk_guest_user());

-- ---- narrow check_dm_cardinality (80-2) -------------------------------------
-- The 0010 version scanned EVERY DM in the database on EVERY membership
-- change: deleting a 20-guest room ran 20 full grouped scans in one commit,
-- and any pre-existing ≠2-member DM anywhere (a state PurgeUser can produce)
-- wedged every transaction touching channel_members -- including the hourly
-- expiry janitor, permanently, on a fault it did not cause. Scope the check
-- to the channel the row actually touched. Same trigger, same deferred
-- timing; CREATE OR REPLACE swaps the body in place.
CREATE OR REPLACE FUNCTION check_dm_cardinality() RETURNS TRIGGER AS $$
DECLARE
  cid UUID;
  dm  BOOLEAN;
  cnt INT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    cid := OLD.channel_id;
  ELSE
    cid := NEW.channel_id;
  END IF;
  -- Channel row already gone (channel deletion cascading its members):
  -- nothing left to be inconsistent.
  SELECT c.is_dm INTO dm FROM channels c WHERE c.id = cid;
  IF dm IS TRUE THEN
    SELECT COUNT(*) INTO cnt FROM channel_members WHERE channel_id = cid;
    IF cnt <> 2 THEN
      RAISE EXCEPTION 'DM channel must have exactly 2 members, found %', cnt
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

COMMIT;

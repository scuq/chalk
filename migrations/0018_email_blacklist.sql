-- Phase 09c: email blacklist table.
--
-- The blacklist tracks email addresses that should never be used for
-- new registrations or email changes. The primary use case is the
-- "purge" admin action (09d): when a user is hard-deleted, their
-- email is added to the blacklist to prevent the same person from
-- immediately re-registering with the same address.
--
-- This migration creates the schema only. 09c uses it as a lookup
-- during registration and email-change validation. 09d adds the
-- admin UI to manage entries.
--
-- Schema notes:
--   - email CITEXT PRIMARY KEY: same case-insensitive semantics as
--     users.email and invites.email.
--   - reason: free-form text. Common values: 'purged_user',
--     'admin_added', 'abuse_report'. No enum so admins can write
--     specific notes.
--   - added_by ON DELETE SET NULL: if the admin who added the entry
--     is later deleted, the entry stands but the reference is nulled.
--   - former_user_id / former_username: denormalized for the admin
--     UI so blacklist entries from purges can show "this was @alice
--     before purge" without joining a deleted row.
--
-- The blacklist is checked during:
--   - POST /api/auth/register/begin (validation order step 2)
--   - POST /api/auth/email-change (same)
--
-- Bypassed for:
--   - Admin bootstrap (so an admin email can be re-bootstrapped after
--     a fresh DB even if a previous admin with the same email was
--     purged)

BEGIN;

CREATE TABLE IF NOT EXISTS email_blacklist (
  email           CITEXT      PRIMARY KEY,
  reason          TEXT        NOT NULL,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by        UUID        REFERENCES users(id) ON DELETE SET NULL,
  former_user_id  UUID,
  former_username CITEXT
);

CREATE INDEX IF NOT EXISTS email_blacklist_added_at_idx
  ON email_blacklist(added_at);

COMMIT;

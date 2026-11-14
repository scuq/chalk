-- chalk -- migration 0063 (65-1: push subscriptions)
--
-- One row per browser that asked for Web Push. The row belongs to the login
-- session that created it: session_token references sessions(token) with
-- ON DELETE CASCADE, so logout, a password change, a recovery reset, an admin
-- block and the expiry sweep all remove the subscription with the session.
-- A session holds at most one subscription, and an endpoint belongs to at
-- most one session.
--
-- Guests cannot hold a row. Their sessions live in ephemeral_sessions, which
-- this table does not reference, and chalk_guest gets no grant here: the
-- absence of a grant is the fence (0050).
--
-- The row holds no message data. endpoint, p256dh and auth are what the
-- browser's push service handed out; scope says which messages push ('dms' or
-- 'all'); generic is reserved for a mode that shows no names (65-10).

CREATE TABLE push_subscriptions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_token bytea NOT NULL UNIQUE REFERENCES sessions(token) ON DELETE CASCADE,
  endpoint      text NOT NULL UNIQUE,
  p256dh        bytea NOT NULL CHECK (octet_length(p256dh) = 65),
  auth          bytea NOT NULL CHECK (octet_length(auth) = 16),
  scope         text NOT NULL DEFAULT 'dms' CHECK (scope IN ('dms', 'all')),
  generic       boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);

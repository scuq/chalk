-- chalk -- migration 0008
-- Instance heartbeats, device presence, presence subscriptions.
--
-- instances
--   Each chalkd process has a row, heartbeated every 5 seconds. The janitor
--   marks instances dead after 15 seconds of silence and clears their
--   device_presence rows. ON DELETE CASCADE on device_presence handles the
--   sweep -- delete the instance row, presence rows cascade out.
--
-- device_presence
--   One row per currently-connected device. Ephemeral; cleared on chalkd
--   startup and on clean shutdown. The hot read pattern is "current state
--   of all devices for user X" (for aggregation) and "devices owned by
--   instance Y" (for janitor).
--
-- presence_subscriptions
--   Per-device "I want to know when these users' presence changes." Phase
--   06's friendship gate is checked on every NOTIFY, not just at subscribe
--   time, so un-friending mid-subscription works correctly.

BEGIN;

CREATE TABLE IF NOT EXISTS instances (
  id              TEXT         PRIMARY KEY,
  last_heartbeat  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  started_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  host            TEXT,
  version         TEXT
);

CREATE INDEX IF NOT EXISTS instances_heartbeat_idx
  ON instances (last_heartbeat);

CREATE TABLE IF NOT EXISTS device_presence (
  device_id    UUID         PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  user_id      UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id  TEXT         NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  device_type  TEXT         NOT NULL,
  state        TEXT         NOT NULL,
  last_seen    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

ALTER TABLE device_presence
  DROP CONSTRAINT IF EXISTS device_presence_state_valid;
ALTER TABLE device_presence
  ADD  CONSTRAINT device_presence_state_valid
  CHECK (state IN ('online', 'away', 'offline'));

ALTER TABLE device_presence
  DROP CONSTRAINT IF EXISTS device_presence_type_valid;
ALTER TABLE device_presence
  ADD  CONSTRAINT device_presence_type_valid
  CHECK (device_type IN ('phone', 'tablet', 'desktop', 'browser-unknown'));

CREATE INDEX IF NOT EXISTS device_presence_user_idx
  ON device_presence (user_id);
CREATE INDEX IF NOT EXISTS device_presence_instance_idx
  ON device_presence (instance_id);
-- The demotion sweep scans by last_seen ascending.
CREATE INDEX IF NOT EXISTS device_presence_stale_idx
  ON device_presence (last_seen) WHERE state <> 'offline';

CREATE TABLE IF NOT EXISTS presence_subscriptions (
  subscriber_device_id  UUID         NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  target_user_id        UUID         NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscribed_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (subscriber_device_id, target_user_id)
);

-- Fast lookup of "who is subscribed to target_user_id" when their
-- presence changes.
CREATE INDEX IF NOT EXISTS presence_subscriptions_target_idx
  ON presence_subscriptions (target_user_id);

COMMIT;

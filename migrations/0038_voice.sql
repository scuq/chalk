-- chalk -- migration 0038 (30-1: voice rooms schema)
--
-- Phase 30 (voice/video) server foundation. Two pieces:
--
--   * channels.channel_type -- 'text' (default, today's behavior) or 'voice'
--     (a Discord-style persistent voice room: click to join, members see who
--     is present). A voice channel reuses EVERYTHING a text channel has --
--     membership, governance, space keys, fan-out -- it only adds live
--     occupancy below.
--
--   * voice_participants -- LIVE room occupancy: who is IN the voice room
--     right now. Ephemeral session state, distinct from channel_members
--     (who is ALLOWED in) and device_presence (online/away/offline). The
--     THIRD presence axis. Rows are inserted on voice_join, deleted on
--     voice_leave / WS disconnect (by conn_id), and swept by an orphan
--     janitor when a row's conn is gone (crash without Unregister).
--
-- No signaling surface in this migration's slice (30-1); frames + routing
-- land in 30-2. See docs/design/chalk-phase-30-voice-video-design.md §3.

BEGIN;

-- ---- channel type -----------------------------------------------------------
ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS channel_type TEXT NOT NULL DEFAULT 'text'
    CHECK (channel_type IN ('text','voice'));

-- ---- live voice-room occupancy ---------------------------------------------
-- PK (channel_id, user_id, device_id): one row per device in a room. v1
-- REJECTS a second device of the same user at join time (echo/feedback);
-- the PK deliberately supports multi-device later without a migration.
CREATE TABLE IF NOT EXISTS voice_participants (
  channel_id  UUID NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  device_id   UUID NOT NULL,
  conn_id     TEXT NOT NULL,        -- WS Conn.ID, for teardown on disconnect
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  muted       BOOLEAN NOT NULL DEFAULT false,
  video_on    BOOLEAN NOT NULL DEFAULT false,
  screen_on   BOOLEAN NOT NULL DEFAULT false,  -- sharing screen/game (Addendum B)
  PRIMARY KEY (channel_id, user_id, device_id)
);

-- Roster fetch for a room.
CREATE INDEX IF NOT EXISTS voice_participants_channel_idx
  ON voice_participants(channel_id);

-- Fast disconnect cleanup by Conn.ID (hub Unregister path, wired in 30-2).
CREATE INDEX IF NOT EXISTS voice_participants_conn_idx
  ON voice_participants(conn_id);

COMMIT;

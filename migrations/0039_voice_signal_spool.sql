-- chalk -- migration 0039 (30-4d: voice signal spool)
--
-- Why: Postgres NOTIFY payloads are hard-capped at 8000 bytes, and
-- internal/pubsub deliberately rejects events over 7800 (notifier.go: events
-- are ROUTING POINTERS; content lives in rows). 30-2's voice_signal relay
-- violated that contract by inlining the E2E-encrypted SDP blob into the
-- NOTIFY -- audio-only offers squeaked under the limit, but a camera-bearing
-- offer (bigger SDP, then encrypted + base64) exceeds it, so the relay's
-- publish failed and the offer silently never reached the peer (found live:
-- rejoin-with-camera left the other side stuck at "connecting").
--
-- Fix: the fetch-on-notify pattern messages already use. The signal payload
-- is spooled here in the SAME transaction as the NOTIFY; the event carries
-- only the row id. Every instance's consumer fetches the row and delivers it
-- to the target device's local conns.
--
-- Lifecycle: rows live for milliseconds in the happy path. They are NOT
-- deleted on fetch -- with multiple chalkd instances every instance receives
-- the NOTIFY and only the one hosting the target device delivers, so a
-- fetch-time DELETE by the wrong instance would race delivery. Instead the
-- voice janitor sweeps rows past a short TTL (see SweepVoiceSignalSpool).

CREATE TABLE IF NOT EXISTS voice_signal_spool (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id  UUID        NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  to_user     UUID        NOT NULL,
  to_device   UUID        NOT NULL,
  from_user   UUID        NOT NULL,
  from_device UUID        NOT NULL,
  kind        TEXT        NOT NULL,
  -- The sender's opaque E2E ciphertext envelope, exactly as posted. BYTEA on
  -- purpose (not JSONB): the server relays it untouched and never inspects,
  -- normalizes, or logs it.
  payload     BYTEA       NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The janitor's sweep predicate.
CREATE INDEX IF NOT EXISTS voice_signal_spool_created_idx
  ON voice_signal_spool(created_at);

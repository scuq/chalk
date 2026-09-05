-- chalk -- migration 0055 (109-1: deafened is broadcast state, like mute)
--
-- Deafening has been purely local since 41-5: the dock's AudioSinks read a
-- flag, nothing is signaled, and the room sees only the self-mute that comes
-- with it. That reads as "their mic is off" when the truth is "they cannot
-- hear you either" -- so people kept talking to someone who had stepped away
-- from the conversation, and the deafened person came back to a room that had
-- been addressing them for ten minutes.
--
-- deafened joins muted / video_on / screen_on as a fourth broadcast media
-- flag on the live occupancy row. It is a courtesy indicator only: the
-- silencing itself stays entirely on the deafened client, so a peer who lies
-- about this flag (or an old client that never sets it) costs nobody
-- anything. Same lifecycle as its three neighbours -- reset to false by the
-- join upsert, so a rejoin never inherits a stale one.

BEGIN;

ALTER TABLE voice_participants
  ADD COLUMN IF NOT EXISTS deafened BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN voice_participants.deafened IS
  'self-deafen, broadcast to the room as an indicator; the silencing is client-side (109-1)';

COMMIT;

-- chalk -- migration 0059 (111-11 / 111-12: better shapes for tall pictures)
--
-- Two changes, both from the same finding: a band is about twelve times wider
-- than it is tall, and a poster is taller than it is wide. Nothing in 111-5's
-- two shapes made that look deliberate -- filled, the poster is an unreadable
-- strip of its own middle; fitted, it is a thumbnail with something beside it.
--
--   banner_bleed 'edge' -> 'wash'. The edge bleed continued a picture's own
--     edge columns outward, which is seamless for a smooth edge and stripey
--     for a poster with a horizon in it: black ridge on one row, red sky on
--     the next, both stretched sideways. The wash is two colours taken from
--     the whole picture and painted as an even gradient, which has no
--     structure in it to streak. 'edge' rows are migrated rather than kept:
--     the style is gone from the client, and a value no renderer knows would
--     draw nothing.
--
--   banner_fit gains 'poster'. The art sits at band height at one end and the
--     wash fills the rest -- a game's box art on a coloured backdrop, which
--     is what every storefront does with exactly this shape problem.
--
-- Both columns keep their CHECKs: the server still refuses a value no
-- renderer can draw.

-- Order matters: the rewrite has to happen with NO constraint in force. The
-- old CHECK forbids 'wash' and the new one forbids 'edge', so a row holding
-- the old value cannot be updated under either -- drop first, rewrite, then
-- put the new fence up over data that already satisfies it.
ALTER TABLE channels
  DROP CONSTRAINT IF EXISTS channels_banner_bleed_valid;

UPDATE channels SET banner_bleed = 'wash' WHERE banner_bleed = 'edge';

ALTER TABLE channels
  ALTER COLUMN banner_bleed SET DEFAULT 'wash';

ALTER TABLE channels
  ADD CONSTRAINT channels_banner_bleed_valid
  CHECK (banner_bleed IN ('wash', 'blur', 'none'));

ALTER TABLE channels
  DROP CONSTRAINT IF EXISTS channels_banner_fit_valid;
ALTER TABLE channels
  ADD CONSTRAINT channels_banner_fit_valid
  CHECK (banner_fit IN ('fill', 'fit', 'poster'));

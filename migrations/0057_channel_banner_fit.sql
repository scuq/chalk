-- chalk -- migration 0057 (111-5: how a banner fills the band)
--
-- 'fill' is 111-3's behaviour: the image is cropped to cover the whole band.
-- It is right for a wide capture and wrong for a portrait poster, which
-- crops to a slice of its own middle. 'fit' shows the whole picture at band
-- height and lets the client fade its edge colours out into the theme
-- background on both sides.
--
-- Channel metadata like name and short_name: server-side plaintext by
-- design, and the same owner-only update path writes it. NOT NULL with a
-- default rather than nullable -- every pre-111-5 channel means 'fill', and
-- a third state would only be a synonym for it.

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS banner_fit text NOT NULL DEFAULT 'fill';

ALTER TABLE channels
  DROP CONSTRAINT IF EXISTS channels_banner_fit_valid;
ALTER TABLE channels
  ADD CONSTRAINT channels_banner_fit_valid
  CHECK (banner_fit IN ('fill', 'fit'));

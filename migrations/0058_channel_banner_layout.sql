-- chalk -- migration 0058 (111-7: the banner's layout)
--
-- 111-3 gave the band one shape and 111-5 gave it two. The editor (111-9)
-- gives the owner the rest of the dial, and these are what it turns:
--
--   banner_focus_x/y  which part of the picture stays visible when the band
--                     crops it. Percentages, 50/50 = the middle, which is
--                     what every pre-111-7 channel was doing implicitly.
--   banner_zoom       percent. 100 is the picture at its natural fit; more
--                     scales it up and lets the band crop tighter.
--   banner_height     short | normal | tall. Everyone in the channel sees
--                     the same height -- it changes the shape of the room,
--                     not one reader's preference (that is the per-device
--                     on/off switch, 111-4).
--   banner_bleed      how a fitted banner fills the space beside itself:
--                     the image's own edge columns, a blurred blow-up of
--                     it, or nothing but the theme background.
--
-- All presentation, all decided by the client, and the server stores them
-- the way it stores a channel's name: as columns it will not interpret. The
-- CHECKs are here so a bad write is refused rather than shipped to every
-- member's renderer -- the same reason short_name has a length CHECK.
--
-- NOT NULL with defaults throughout: every channel that predates this means
-- exactly the defaults, and a nullable column would only add a second way to
-- spell them.

ALTER TABLE channels
  ADD COLUMN IF NOT EXISTS banner_focus_x smallint NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS banner_focus_y smallint NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS banner_zoom    smallint NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS banner_height  text     NOT NULL DEFAULT 'normal',
  ADD COLUMN IF NOT EXISTS banner_bleed   text     NOT NULL DEFAULT 'edge';

ALTER TABLE channels
  DROP CONSTRAINT IF EXISTS channels_banner_focus_range;
ALTER TABLE channels
  ADD CONSTRAINT channels_banner_focus_range
  CHECK (banner_focus_x BETWEEN 0 AND 100 AND banner_focus_y BETWEEN 0 AND 100);

ALTER TABLE channels
  DROP CONSTRAINT IF EXISTS channels_banner_zoom_range;
ALTER TABLE channels
  ADD CONSTRAINT channels_banner_zoom_range
  CHECK (banner_zoom BETWEEN 100 AND 300);

ALTER TABLE channels
  DROP CONSTRAINT IF EXISTS channels_banner_height_valid;
ALTER TABLE channels
  ADD CONSTRAINT channels_banner_height_valid
  CHECK (banner_height IN ('short', 'normal', 'tall'));

ALTER TABLE channels
  DROP CONSTRAINT IF EXISTS channels_banner_bleed_valid;
ALTER TABLE channels
  ADD CONSTRAINT channels_banner_bleed_valid
  CHECK (banner_bleed IN ('edge', 'blur', 'none'));

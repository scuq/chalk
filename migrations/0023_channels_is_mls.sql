-- Phase 11b-2: per-channel "is this MLS-encrypted" flag.
--
-- Set at channel creation time (true for new DMs, false for
-- everything else). Never changes. Pre-11b channels default to
-- false (strict cutover policy).
--
-- This flag is the client's signal to encrypt sends and decrypt
-- received messages for the channel. The server uses it for
-- nothing -- it just stores and surfaces it. Channel-level mode
-- decisions stay client-driven.

ALTER TABLE channels
    ADD COLUMN IF NOT EXISTS is_mls BOOLEAN NOT NULL DEFAULT false;

-- chalk -- migration 0048 (phase 54-2: channel groups)
-- group_name: the creator's grouping SUGGESTION for the roster.
--
-- Set once at channel creation and never updated server-side: the group a
-- channel renders under is a per-user choice (prefs.roster.groupOverrides,
-- resolved client-side), and keeping the server value immutable means nobody
-- can reshuffle another user's roster after the fact. The server stores a
-- hint; the client owns the view. See docs/phases/PHASE-54-ROSTER.md.
--
-- Plaintext by design: same privacy class as channels.name, which the server
-- already holds in the clear. Existing channels (and DMs, which are never
-- rendered grouped) land in 'General' via the DEFAULT.

ALTER TABLE channels
  ADD COLUMN group_name text NOT NULL DEFAULT 'General';

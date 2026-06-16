-- Phase 21-6 (crypto rebuild): drop the now-unused MLS tables.
--
-- The MLS/CoreCrypto stack was removed in phases 21-1 .. 21-5:
--   * client mls/ module, @wireapp/core-crypto, WASM   (21-1..21-3)
--   * server WS dispatch + handlers + store layer       (21-4, 21-5a/b)
--   * MLS wire types in the Go + TS proto packages       (21-5c/d)
-- Nothing reads or writes these tables anymore. Drop them.
--
-- IRREVERSIBLE: any rows here (buffered KeyPackages, group state, the
-- commit log, pending Welcomes) are destroyed. Old MLS-encrypted message
-- history in the `messages` table becomes permanently undecryptable
-- because the group secrets needed to read it lived in client-local
-- CoreCrypto state (already gone) -- this drop only removes the
-- server-side bookkeeping. Accepted: chalk is pre-release / test data.
--
-- NOTE: channels.is_mls (migration 0023) is intentionally KEPT -- it is
-- still threaded through the channel CRUD path (internal/store/channels.go)
-- and the SPA. De-threading it is separate cleanup (phase 23 redefines
-- what an "encrypted channel" means under wrapped space keys).
--
-- No inbound foreign keys reference these tables, so CASCADE only drops
-- each table's own indexes/constraints (e.g. key_packages_unused_by_device),
-- not any surviving table.

DROP TABLE IF EXISTS key_packages CASCADE;
DROP TABLE IF EXISTS mls_groups CASCADE;
DROP TABLE IF EXISTS mls_commits CASCADE;
DROP TABLE IF EXISTS mls_pending_welcomes CASCADE;

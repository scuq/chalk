-- Phase 21-7e: drop messages.content_type.
-- Encryption removed (21-7a/b): every body is plaintext, no
-- application/mls_ciphertext distinction. Column is dead. Paired with the
-- INSERT cleanup in store/messages.go + server/ws.go (they stop writing
-- the literal 'application'). No index/constraint references it.
-- messages is partitioned by ts; DROP COLUMN propagates to all partitions.
ALTER TABLE messages DROP COLUMN IF EXISTS content_type;

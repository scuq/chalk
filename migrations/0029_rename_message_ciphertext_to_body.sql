-- Phase 21-7e: rename messages.ciphertext -> messages.body.
-- With no encryption the column holds plaintext; "ciphertext" misleads.
-- Code already renamed in 21-7c. RENAME COLUMN is metadata-only (no
-- rewrite), preserves data, propagates across partitions. No index refs it.
ALTER TABLE messages RENAME COLUMN ciphertext TO body;

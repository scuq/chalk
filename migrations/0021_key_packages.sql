-- Phase 11a: per-device MLS KeyPackage stock.
--
-- A KeyPackage is a one-shot public credential that another user
-- consumes when adding this device to an MLS group. Each device
-- maintains a stock; the client refills when low.
--
-- Lifecycle:
--   * INSERT on publish (client publishes a batch of fresh KPs)
--   * UPDATE used_at when someone claims one to add this device
--   * Rows are NEVER deleted -- audit trail of who joined when,
--     including stale rows where used_at IS NOT NULL. A periodic
--     prune (out of scope for 11a) can drop rows beyond N days
--     past used_at.
--
-- Notes:
--   * ciphersuite + credential_type are MLS protocol parameters.
--     We store them so clients can request KPs for the cipher
--     suite they intend to use. Chalk currently uses suite 0x0001
--     (MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519) and credential
--     type 1 (Basic). Future-proof for migration.
--   * key_package_data is the raw TLS-serialized KeyPackage from
--     CoreCrypto (opaque to the server -- we don't decode it).
--   * client_id_claimed is the "<userID>:<deviceID>" string the
--     client put inside the KeyPackage's Basic credential. We
--     store it for server-side sanity checks at fetch time. The
--     server validates that client_id_claimed matches the
--     publishing connection's authenticated user+device.

CREATE TABLE IF NOT EXISTS key_packages (
    id BIGSERIAL PRIMARY KEY,
    device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    ciphersuite INTEGER NOT NULL,
    credential_type INTEGER NOT NULL,
    client_id_claimed TEXT NOT NULL,
    key_package_data BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    used_at TIMESTAMPTZ -- NULL = available, non-NULL = consumed
);

-- Fast claim path: "give me an unused KP for device X with suite Y".
CREATE INDEX IF NOT EXISTS key_packages_unused_by_device
    ON key_packages (device_id, ciphersuite)
    WHERE used_at IS NULL;

-- Fast count path: "how many unused KPs does device X have?"
-- Same partial index covers this; the optimizer can use it.

-- Fast lookup for "give me KPs for these user IDs" by joining
-- through devices(user_id, id). The devices table already has an
-- index on user_id (phase 02 schema).

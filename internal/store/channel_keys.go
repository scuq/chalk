package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ChannelKey is a channel's space key wrapped to ONE member, for one
// key_version. The server stores and relays these blobs opaquely; it never
// holds a plaintext space key (it cannot: it has no member private key).
//
// CRYPTO AGILITY (see docs/design/crypto-agility.md): WrapSuite identifies
// the wrap construction and Blob is its opaque, suite-defined serialization,
// so a future post-quantum KEM (with a differently-shaped/larger wrap) needs
// no schema change. Suite 1 today = X25519 -> HKDF-SHA256 -> AES-256-GCM,
// Blob = ephemeralPub(32) || nonce(12) || wrapped(48) = 92 bytes.
//
// KeyVersion is rotation (same algorithm, new key material; phase 25), not
// the crypto suite. A missing (ChannelID, KeyVersion, RecipientID) row is
// the signal that the member still needs the key wrapped for them -- an
// online member who holds it does the wrapping (the server cannot).
type ChannelKey struct {
	ChannelID   uuid.UUID
	KeyVersion  int
	RecipientID uuid.UUID
	WrapSuite   int
	Blob        []byte
	CreatedAt   time.Time
}

// PutChannelKey stores (or replaces) the wrapped space key for one member at
// one key_version. Idempotent per (channel_id, key_version, recipient_id):
// re-wrapping the same slot overwrites in place. The caller must already
// have authorized that both the wrapping user and RecipientID are members of
// the channel (enforced at the handler layer).
func (s *Store) PutChannelKey(ctx context.Context, k ChannelKey) error {
	if len(k.Blob) == 0 {
		return fmt.Errorf("PutChannelKey: wrap blob is empty")
	}
	if k.WrapSuite < 1 {
		return fmt.Errorf("PutChannelKey: wrap_suite must be >= 1, got %d", k.WrapSuite)
	}
	ver := k.KeyVersion
	if ver < 1 {
		ver = 1
	}
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO channel_keys
		   (channel_id, key_version, recipient_id, wrap_suite, wrap_blob, created_at)
		 VALUES ($1, $2, $3, $4, $5, now())
		 ON CONFLICT (channel_id, key_version, recipient_id) DO UPDATE
		   SET wrap_suite = EXCLUDED.wrap_suite,
		       wrap_blob  = EXCLUDED.wrap_blob`,
		k.ChannelID, ver, k.RecipientID, k.WrapSuite, k.Blob,
	)
	if err != nil {
		return fmt.Errorf("put channel key: %w", err)
	}
	return nil
}

// GetChannelKey returns the space key wrapped for recipientID in the given
// channel + key_version. Returns ErrNotFound if no wrap exists yet (the
// member must wait for an online member to wrap it for them).
func (s *Store) GetChannelKey(ctx context.Context, channelID uuid.UUID, keyVersion int, recipientID uuid.UUID) (ChannelKey, error) {
	if keyVersion < 1 {
		keyVersion = 1
	}
	var k ChannelKey
	err := s.Pool.QueryRow(ctx,
		`SELECT channel_id, key_version, recipient_id, wrap_suite, wrap_blob, created_at
		   FROM channel_keys
		  WHERE channel_id = $1 AND key_version = $2 AND recipient_id = $3`,
		channelID, keyVersion, recipientID,
	).Scan(&k.ChannelID, &k.KeyVersion, &k.RecipientID, &k.WrapSuite, &k.Blob, &k.CreatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return ChannelKey{}, ErrNotFound
	}
	if err != nil {
		return ChannelKey{}, fmt.Errorf("get channel key: %w", err)
	}
	return k, nil
}

// ListChannelKeyRecipients returns the user_ids that already have a wrapped
// key for (channelID, keyVersion). The "online-member auto-rewrap" flow
// diffs this against ListMembersForChannel to find who still needs the key,
// then wraps it for them. This is the dedicated query that drives key
// distribution; the server only reports who has a wrap, never the keys.
func (s *Store) ListChannelKeyRecipients(ctx context.Context, channelID uuid.UUID, keyVersion int) ([]uuid.UUID, error) {
	if keyVersion < 1 {
		keyVersion = 1
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT recipient_id FROM channel_keys
		  WHERE channel_id = $1 AND key_version = $2`,
		channelID, keyVersion,
	)
	if err != nil {
		return nil, fmt.Errorf("query channel_keys recipients: %w", err)
	}
	defer rows.Close()

	var out []uuid.UUID
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan channel_keys recipient: %w", err)
		}
		out = append(out, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows.Err channel_keys recipients: %w", err)
	}
	return out, nil
}

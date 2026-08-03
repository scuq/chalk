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

// PutChannelKey stores the wrapped space key for one member at one
// key_version. The caller must already have authorized that both the wrapping
// user (callerID) and RecipientID are members of the channel (enforced at the
// handler layer).
//
// 82-6: the upsert used to be an unbounded DO UPDATE, which let ANY member
// silently overwrite any other member's wrap slot at any key version. A filled
// slot is now overwritten only when
//
//   - the caller is the recipient (re-wrapping one's OWN slot -- the bootstrap
//     read-back convergence between a user's devices), or
//   - the new wrap's suite is strictly higher than the stored one (the
//     self-healing sweep upgrading a legacy unsigned wrap to a signed one).
//
// Anything else is a silent no-op rather than an error, deliberately: two
// holders auto-rewrapping the same missing member race here, and the loser's
// write is an equal-suite overwrite carrying the same key -- refusing it loses
// nothing, while erroring would make a benign race look like a failure. The
// server cannot tell those writes from hostile ones (it cannot open the blobs);
// what it CAN do is make "quietly replace an existing wrap" impossible, which
// is the store-side echo of the client's never-replace rule.
func (s *Store) PutChannelKey(ctx context.Context, k ChannelKey, callerID uuid.UUID) error {
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
		       wrap_blob  = EXCLUDED.wrap_blob
		 WHERE channel_keys.recipient_id = $6
		    OR EXCLUDED.wrap_suite > channel_keys.wrap_suite`,
		k.ChannelID, ver, k.RecipientID, k.WrapSuite, k.Blob, callerID,
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

// ChannelKeyRecipient is one member's standing in a channel's key
// distribution: they hold a wrap, produced under WrapSuite. 82-6 added the
// suite so holders can see WHICH members still sit on a legacy unsigned wrap
// and heal them -- the suite of a wrap was never secret (the recipient reads
// it off their own row), only unreported.
type ChannelKeyRecipient struct {
	RecipientID uuid.UUID
	WrapSuite   int
}

// ListChannelKeyRecipients returns who already has a wrapped key for
// (channelID, keyVersion), and under which wrap suite. The "online-member
// auto-rewrap" flow diffs this against ListMembersForChannel to find who
// still needs the key (or still needs it re-wrapped under a better suite),
// then wraps it for them. The server only reports who has a wrap and how it
// is framed, never the keys.
func (s *Store) ListChannelKeyRecipients(ctx context.Context, channelID uuid.UUID, keyVersion int) ([]ChannelKeyRecipient, error) {
	if keyVersion < 1 {
		keyVersion = 1
	}
	rows, err := s.Pool.Query(ctx,
		`SELECT recipient_id, wrap_suite FROM channel_keys
		  WHERE channel_id = $1 AND key_version = $2`,
		channelID, keyVersion,
	)
	if err != nil {
		return nil, fmt.Errorf("query channel_keys recipients: %w", err)
	}
	defer rows.Close()

	var out []ChannelKeyRecipient
	for rows.Next() {
		var r ChannelKeyRecipient
		if err := rows.Scan(&r.RecipientID, &r.WrapSuite); err != nil {
			return nil, fmt.Errorf("scan channel_keys recipient: %w", err)
		}
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows.Err channel_keys recipients: %w", err)
	}
	return out, nil
}

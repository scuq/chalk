package store

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// 83-5: first-responder key rotation, one atomic transaction (D.2, R16-2).
//
// WHY ONE REQUEST. A version ceiling alone serializes the version NUMBER,
// not which key becomes it: two responders uploading per-recipient wraps
// independently could hand different recipients different keys for the same
// version and only then race the bump. So wraps are never published
// piecemeal for a rotation -- one request carries every wrap, the row lock
// on the channel serializes responders, and exactly one of them advances
// the version. The loser learns the current version and fetches the
// winner's wrap; a mixed key generation cannot exist in any interleaving.

// RotationWrap is one recipient's signed wrap of the new space key.
type RotationWrap struct {
	RecipientID uuid.UUID
	WrapSuite   int
	Blob        []byte
}

// StaleRotationError reports that current_key_version was not the
// expected_version the responder built against. Current is what it is now,
// so the caller can refetch that version's wrap instead of retrying blindly.
type StaleRotationError struct{ Current int }

func (e *StaleRotationError) Error() string {
	return fmt.Sprintf("stale rotation: current_key_version is %d", e.Current)
}

// ErrRosterMismatch: the wraps do not cover exactly the current roster.
var ErrRosterMismatch = errors.New("rotation wraps must cover exactly the current roster")

// ErrWrapUnsigned: a rotation wrap was not a signed suite.
var ErrWrapUnsigned = errors.New("rotation wraps must be signed")

// RotateChannelKeyAtomic performs the whole rotation in one transaction:
// lock the channel row; require the caller is a member and
// current_key_version == expected (and, when a rotation is due, that it is
// due from exactly expected); require the wraps name exactly the current
// roster, every one signed (suite >= 2) and within maxBlobBytes; insert all
// wraps at expected+1 (a winner's wraps overwrite any piecemeal row an older
// client may have parked there); advance the version and clear the due mark.
// Returns the new version.
//
// Any member may rotate -- nobody special is required, which is what keeps
// a 2-person channel or an owner-leaves channel from freezing (the product
// invariant: membership changes never freeze a channel).
func (s *Store) RotateChannelKeyAtomic(
	ctx context.Context,
	channelID, callerID uuid.UUID,
	expected int,
	wraps []RotationWrap,
	maxBlobBytes int,
) (int, error) {
	if expected < 1 {
		return 0, fmt.Errorf("expected_version must be >= 1")
	}
	newVersion := expected + 1
	err := s.withTx(ctx, func(tx pgx.Tx) error {
		var current int
		var dueFrom *int
		if err := tx.QueryRow(ctx,
			`SELECT current_key_version, rotation_due_from FROM channels WHERE id = $1 FOR UPDATE`,
			channelID,
		).Scan(&current, &dueFrom); err != nil {
			if errors.Is(err, pgx.ErrNoRows) {
				return ErrChannelNotFound
			}
			return err
		}
		var isMember bool
		if err := tx.QueryRow(ctx,
			`SELECT EXISTS(SELECT 1 FROM channel_members WHERE channel_id = $1 AND user_id = $2)`,
			channelID, callerID,
		).Scan(&isMember); err != nil {
			return err
		}
		if !isMember {
			return ErrNotAMember
		}
		if current != expected || (dueFrom != nil && *dueFrom != expected) {
			return &StaleRotationError{Current: current}
		}
		rows, err := tx.Query(ctx, `SELECT user_id FROM channel_members WHERE channel_id = $1`, channelID)
		if err != nil {
			return err
		}
		roster := map[uuid.UUID]bool{}
		for rows.Next() {
			var id uuid.UUID
			if err := rows.Scan(&id); err != nil {
				rows.Close()
				return err
			}
			roster[id] = false
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		if len(wraps) != len(roster) {
			return ErrRosterMismatch
		}
		for _, w := range wraps {
			seen, ok := roster[w.RecipientID]
			if !ok || seen {
				return ErrRosterMismatch // stranger, or a duplicate
			}
			roster[w.RecipientID] = true
			if w.WrapSuite < 2 {
				return ErrWrapUnsigned
			}
			if len(w.Blob) == 0 || len(w.Blob) > maxBlobBytes {
				return fmt.Errorf("rotation wrap blob for %s out of bounds (%d bytes)", w.RecipientID, len(w.Blob))
			}
		}
		for _, w := range wraps {
			if _, err := tx.Exec(ctx,
				`INSERT INTO channel_keys
				   (channel_id, key_version, recipient_id, wrap_suite, wrap_blob, created_at)
				 VALUES ($1, $2, $3, $4, $5, now())
				 ON CONFLICT (channel_id, key_version, recipient_id) DO UPDATE
				   SET wrap_suite = EXCLUDED.wrap_suite,
				       wrap_blob  = EXCLUDED.wrap_blob`,
				channelID, newVersion, w.RecipientID, w.WrapSuite, w.Blob,
			); err != nil {
				return fmt.Errorf("insert rotation wrap: %w", err)
			}
		}
		if _, err := tx.Exec(ctx,
			`UPDATE channels
			    SET current_key_version = $2,
			        rotation_pending = FALSE,
			        rotation_due_from = NULL
			  WHERE id = $1 AND current_key_version = $3`,
			channelID, newVersion, expected,
		); err != nil {
			return fmt.Errorf("advance key version: %w", err)
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	return newVersion, nil
}

// ChannelKeyState returns the current key version and the rotation-due mark
// together, as the send gate needs them (83-5).
func (s *Store) ChannelKeyState(ctx context.Context, channelID uuid.UUID) (current int, dueFrom *int, err error) {
	err = s.Pool.QueryRow(ctx,
		`SELECT current_key_version, rotation_due_from FROM channels WHERE id = $1`,
		channelID,
	).Scan(&current, &dueFrom)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, nil, ErrChannelNotFound
	}
	return current, dueFrom, err
}

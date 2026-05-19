package store

// Phase 11b-1: MLS group state per channel.
//
// The server treats mls_group_id, commit bytes, and welcome bytes
// as opaque. This file only stores/retrieves the bytes; it does not
// parse the MLS protocol.

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MlsGroup is one row from mls_groups.
type MlsGroup struct {
	ChannelID     uuid.UUID
	MlsGroupID    []byte
	CreatorUserID uuid.UUID
	CurrentEpoch  int64
}

// ErrMlsGroupExists is returned by UpsertMlsGroup when a different
// mls_group_id is already stored for the same channel. Channels
// have exactly one MLS group; reassigning would orphan the previous
// group and is a protocol error.
var ErrMlsGroupExists = errors.New("channel already has a different MLS group")

// UpsertMlsGroup creates the row if absent, or bumps the epoch +
// updated_at if it already exists for the same group_id. Returns
// ErrMlsGroupExists if the channel has a different group_id on
// file.
func (s *Store) UpsertMlsGroup(
	ctx context.Context,
	channelID uuid.UUID,
	mlsGroupID []byte,
	creatorUserID uuid.UUID,
	epoch int64,
) error {
	return s.withTx(ctx, func(tx pgx.Tx) error {
		var existingGroupID []byte
		err := tx.QueryRow(ctx,
			`SELECT mls_group_id FROM mls_groups WHERE channel_id = $1`,
			channelID,
		).Scan(&existingGroupID)
		switch {
		case errors.Is(err, pgx.ErrNoRows):
			// First time: insert.
			if _, err := tx.Exec(ctx,
				`INSERT INTO mls_groups
				   (channel_id, mls_group_id, creator_user_id, current_epoch)
				 VALUES ($1, $2, $3, $4)`,
				channelID, mlsGroupID, creatorUserID, epoch,
			); err != nil {
				return fmt.Errorf("insert mls_group: %w", err)
			}
			return nil
		case err != nil:
			return fmt.Errorf("lookup existing mls_group: %w", err)
		}
		// Row exists. Same group? Just bump epoch + updated_at.
		if !bytesEqual(existingGroupID, mlsGroupID) {
			return ErrMlsGroupExists
		}
		if _, err := tx.Exec(ctx,
			`UPDATE mls_groups
			    SET current_epoch = $2, updated_at = NOW()
			  WHERE channel_id = $1`,
			channelID, epoch,
		); err != nil {
			return fmt.Errorf("update mls_group epoch: %w", err)
		}
		return nil
	})
}

// GetMlsGroup returns the row for the given channel, or nil if the
// channel doesn't have an MLS group.
func (s *Store) GetMlsGroup(
	ctx context.Context,
	channelID uuid.UUID,
) (*MlsGroup, error) {
	var g MlsGroup
	err := s.Pool.QueryRow(ctx,
		`SELECT channel_id, mls_group_id, creator_user_id, current_epoch
		   FROM mls_groups
		  WHERE channel_id = $1`,
		channelID,
	).Scan(&g.ChannelID, &g.MlsGroupID, &g.CreatorUserID, &g.CurrentEpoch)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &g, nil
}

func bytesEqual(a, b []byte) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

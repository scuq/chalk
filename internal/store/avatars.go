package store

// 112-1: profile pictures.
//
// A picture lives in channel_avatars as a pointer: (channel_id, user_id) ->
// attachment_id. The bytes are an ordinary attachment -- chunk-uploaded,
// encrypted client-side under that channel's key, never linked to a message --
// so this file never sees an image, only ids.
//
// Per channel is the whole design: there is no key shared between a user and
// everyone entitled to see their face, so the same picture is uploaded once
// per channel and recorded here. The cost is a fan-out on change; the record
// of why that is the trade is in docs/phases/PHASE-112-AVATARS.md.

import (
	"context"
	"errors"
	"fmt"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// ChannelAvatar is one member's picture in one channel.
type ChannelAvatar struct {
	UserID       uuid.UUID
	AttachmentID uuid.UUID
	KeyVersion   int
}

// ErrAvatarNotFound is returned when a user has no picture in a channel.
var ErrAvatarNotFound = errors.New("no avatar for that user in that channel")

// SetChannelAvatar points a member's picture in one channel at an attachment.
// Upsert: setting a new picture replaces the old row, which is what a change
// is. The caller has already checked that the attachment is complete, belongs
// to this channel, and was uploaded by this user.
func (s *Store) SetChannelAvatar(
	ctx context.Context,
	channelID, userID, attachmentID uuid.UUID,
	keyVersion int,
) error {
	_, err := s.Pool.Exec(ctx,
		`INSERT INTO channel_avatars (channel_id, user_id, attachment_id, key_version, updated_at)
		      VALUES ($1, $2, $3, $4, now())
		 ON CONFLICT (channel_id, user_id)
		   DO UPDATE SET attachment_id = EXCLUDED.attachment_id,
		                 key_version   = EXCLUDED.key_version,
		                 updated_at    = now()`,
		channelID, userID, attachmentID, keyVersion,
	)
	if err != nil {
		return fmt.Errorf("set channel avatar: %w", err)
	}
	return nil
}

// ClearChannelAvatar removes a member's picture from one channel. Removing one
// that is not there is not an error: "I have no picture here" is the state the
// caller asked for either way.
func (s *Store) ClearChannelAvatar(ctx context.Context, channelID, userID uuid.UUID) error {
	_, err := s.Pool.Exec(ctx,
		`DELETE FROM channel_avatars WHERE channel_id = $1 AND user_id = $2`,
		channelID, userID,
	)
	if err != nil {
		return fmt.Errorf("clear channel avatar: %w", err)
	}
	return nil
}

// ListChannelAvatars returns every member's picture in one channel. Only
// members may ask -- the EXISTS gate is the same one the attachment endpoints
// use, so a non-member gets an empty list rather than a map of who has a face
// on file.
func (s *Store) ListChannelAvatars(
	ctx context.Context,
	channelID, requesterUserID uuid.UUID,
) ([]ChannelAvatar, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT a.user_id, a.attachment_id, a.key_version
		   FROM channel_avatars a
		  WHERE a.channel_id = $1
		    AND EXISTS (
		      SELECT 1 FROM channel_members cm
		       WHERE cm.channel_id = a.channel_id AND cm.user_id = $2
		    )
		  ORDER BY a.user_id`,
		channelID, requesterUserID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]ChannelAvatar, 0, 16)
	for rows.Next() {
		var av ChannelAvatar
		if err := rows.Scan(&av.UserID, &av.AttachmentID, &av.KeyVersion); err != nil {
			return nil, err
		}
		out = append(out, av)
	}
	return out, rows.Err()
}

// ListChannelsWithAvatarForUser returns the channels where a user currently
// has a picture. The fan-out reads it to know what a removal has to reach, and
// what a replacement is replacing.
func (s *Store) ListChannelsWithAvatarForUser(
	ctx context.Context,
	userID uuid.UUID,
) ([]uuid.UUID, error) {
	rows, err := s.Pool.Query(ctx,
		`SELECT channel_id FROM channel_avatars WHERE user_id = $1`,
		userID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]uuid.UUID, 0, 16)
	for rows.Next() {
		var id uuid.UUID
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// GetChannelAvatar returns one member's picture in one channel, or
// ErrAvatarNotFound. Membership is the caller's to check; this is the read the
// push path uses to echo what it just wrote.
func (s *Store) GetChannelAvatar(
	ctx context.Context,
	channelID, userID uuid.UUID,
) (ChannelAvatar, error) {
	var av ChannelAvatar
	err := s.Pool.QueryRow(ctx,
		`SELECT user_id, attachment_id, key_version
		   FROM channel_avatars WHERE channel_id = $1 AND user_id = $2`,
		channelID, userID,
	).Scan(&av.UserID, &av.AttachmentID, &av.KeyVersion)
	if errors.Is(err, pgx.ErrNoRows) {
		return ChannelAvatar{}, ErrAvatarNotFound
	}
	if err != nil {
		return ChannelAvatar{}, err
	}
	return av, nil
}

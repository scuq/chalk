package store

// 106-2 / 106-3: renaming a channel and its optional short name.
//
// Both are plain metadata writes on the channels row: the name is what
// the server already holds in the clear, so a rename has no key or
// envelope implications -- nothing the client signs binds the channel
// name. Authorization (owner only, dictator mode only, never a DM) is the
// handler's job; the store only knows how to normalize and write.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// MaxShortNameLen is the character cap on channels.short_name, mirrored
// by migration 0054's CHECK (char_length, so characters not bytes).
const MaxShortNameLen = 10

// ErrShortNameTooLong is returned when a short name exceeds MaxShortNameLen
// characters after trimming.
var ErrShortNameTooLong = fmt.Errorf("short_name too long (max %d characters)", MaxShortNameLen)

// NormalizeShortName trims a short name and fences its length. Empty (or
// whitespace-only) means "no short name" and normalizes to "".
func NormalizeShortName(s string) (string, error) {
	t := strings.TrimSpace(s)
	if utf8.RuneCountInString(t) > MaxShortNameLen {
		return "", ErrShortNameTooLong
	}
	return t, nil
}

// UpdateChannelNamesInput names what changes. A nil field is left alone;
// a non-nil one is written (after normalization). Name may not be blank;
// ShortName may be, which clears it.
type UpdateChannelNamesInput struct {
	ChannelID uuid.UUID
	Name      *string
	ShortName *string
}

// ErrChannelNameRequired is returned when a rename would leave the name
// blank.
var ErrChannelNameRequired = errors.New("channel name required")

// UpdateChannelNames writes the requested fields and returns the channel
// as it now reads. With neither field set it is a read. Returns
// ErrChannelNotFound when the id has no row.
func (s *Store) UpdateChannelNames(ctx context.Context, in UpdateChannelNamesInput) (Channel, error) {
	var name, short *string
	if in.Name != nil {
		t := strings.TrimSpace(*in.Name)
		if t == "" {
			return Channel{}, ErrChannelNameRequired
		}
		name = &t
	}
	if in.ShortName != nil {
		t, err := NormalizeShortName(*in.ShortName)
		if err != nil {
			return Channel{}, err
		}
		short = &t
	}
	var ch Channel
	err := s.Pool.QueryRow(ctx,
		`UPDATE channels
		    SET name = COALESCE($2, name),
		        short_name = COALESCE($3, short_name)
		  WHERE id = $1
		  RETURNING id, name, is_dm, created_by, created_at, current_key_version, rotation_pending, rotation_due_from, governance_mode, channel_type, group_name, expires_at, short_name`,
		in.ChannelID, name, short,
	).Scan(&ch.ID, &ch.Name, &ch.IsDM, &ch.CreatedBy, &ch.CreatedAt, &ch.CurrentKeyVersion, &ch.RotationPending, &ch.RotationDueFrom, &ch.GovernanceMode, &ch.ChannelType, &ch.GroupName, &ch.ExpiresAt, &ch.ShortName)
	if errors.Is(err, pgx.ErrNoRows) {
		return Channel{}, ErrChannelNotFound
	}
	if err != nil {
		return Channel{}, fmt.Errorf("update channel names: %w", err)
	}
	return ch, nil
}

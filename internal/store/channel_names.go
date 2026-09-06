package store

// 106-2 / 106-3: renaming a channel and its optional short name.
// 111-1: the same write path carries the channel banner.
//
// All three are plain metadata writes on the channels row: the name is
// what the server already holds in the clear, so a rename has no key or
// envelope implications -- nothing the client signs binds the channel
// name. The banner adds only a uuid pointing at an attachments row whose
// bytes the server cannot read. Authorization (owner only, dictator mode
// only, never a DM) is the handler's job; the store only knows how to
// normalize and write.

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
//
// 111-7: the banner arrives as its own patch, because it is its own
// thing: nil leaves every part of it alone, and a non-nil one writes
// exactly the fields it sets. SetAttachment is the "touch the image"
// flag -- AttachmentID nil with the flag set clears the picture, which a
// plain *uuid.UUID could not say. The handler has already checked that
// the id names a complete attachment of this channel and that every
// other field is in range; the store does not re-check.
type BannerPatch struct {
	SetAttachment bool
	AttachmentID  *uuid.UUID
	Fit           *string
	FocusX        *int
	FocusY        *int
	Zoom          *int
	Height        *string
	Bleed         *string
}

// UpdateChannelNamesInput is what one update_channel writes. A nil field
// is left alone; a non-nil one is written after normalization.
type UpdateChannelNamesInput struct {
	ChannelID uuid.UUID
	Name      *string
	ShortName *string
	Banner    *BannerPatch
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
	// 111-7: every banner field is normalized here, once, and every one of
	// them is a "leave alone" when the patch does not mention it.
	b := in.Banner
	var fit, height, bleed *string
	var focusX, focusY, zoom *int
	setAttachment := false
	var attachmentID *uuid.UUID
	if b != nil {
		setAttachment = b.SetAttachment
		attachmentID = b.AttachmentID
		if b.Fit != nil {
			t, err := NormalizeBannerFit(*b.Fit)
			if err != nil {
				return Channel{}, err
			}
			fit = &t
		}
		if b.Height != nil {
			t, err := NormalizeBannerHeight(*b.Height)
			if err != nil {
				return Channel{}, err
			}
			height = &t
		}
		if b.Bleed != nil {
			t, err := NormalizeBannerBleed(*b.Bleed)
			if err != nil {
				return Channel{}, err
			}
			bleed = &t
		}
		if b.Zoom != nil {
			if err := CheckBannerZoom(*b.Zoom); err != nil {
				return Channel{}, err
			}
			zoom = b.Zoom
		}
		for _, f := range []*int{b.FocusX, b.FocusY} {
			if f == nil {
				continue
			}
			if err := CheckBannerFocus(*f); err != nil {
				return Channel{}, err
			}
		}
		focusX, focusY = b.FocusX, b.FocusY
	}

	var ch Channel
	// The image column cannot use COALESCE the way everything else does:
	// NULL is a value it takes (clearing the picture), not "leave alone".
	// The flag carries that apart. The layout columns are NOT NULL, so
	// COALESCE says exactly the right thing for them.
	err := s.Pool.QueryRow(ctx,
		`UPDATE channels
		    SET name = COALESCE($2, name),
		        short_name = COALESCE($3, short_name),
		        banner_attachment_id = CASE WHEN $4 THEN $5 ELSE banner_attachment_id END,
		        banner_fit = COALESCE($6, banner_fit),
		        banner_focus_x = COALESCE($7, banner_focus_x),
		        banner_focus_y = COALESCE($8, banner_focus_y),
		        banner_zoom = COALESCE($9, banner_zoom),
		        banner_height = COALESCE($10, banner_height),
		        banner_bleed = COALESCE($11, banner_bleed)
		  WHERE id = $1
		  RETURNING id, name, is_dm, created_by, created_at, current_key_version, rotation_pending, rotation_due_from, governance_mode, channel_type, group_name, expires_at, short_name, banner_attachment_id, banner_fit, banner_focus_x, banner_focus_y, banner_zoom, banner_height, banner_bleed`,
		in.ChannelID, name, short, setAttachment, attachmentID, fit, focusX, focusY, zoom, height, bleed,
	).Scan(&ch.ID, &ch.Name, &ch.IsDM, &ch.CreatedBy, &ch.CreatedAt, &ch.CurrentKeyVersion, &ch.RotationPending, &ch.RotationDueFrom, &ch.GovernanceMode, &ch.ChannelType, &ch.GroupName, &ch.ExpiresAt, &ch.ShortName, &ch.Banner.AttachmentID, &ch.Banner.Fit, &ch.Banner.FocusX, &ch.Banner.FocusY, &ch.Banner.Zoom, &ch.Banner.Height, &ch.Banner.Bleed)
	if errors.Is(err, pgx.ErrNoRows) {
		return Channel{}, ErrChannelNotFound
	}
	if err != nil {
		return Channel{}, fmt.Errorf("update channel names: %w", err)
	}
	return ch, nil
}
